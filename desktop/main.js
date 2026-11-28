import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, session } from 'electron';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup } from 'node:sqlite';
import { Store } from './core/store.js';
import { Engine } from './core/engine.js';
import { createCloud } from './core/cloud.js';
import { COUNTER_URL, desktopCsp, assetPath, trustedSender } from './core/security.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'pos', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const root = dirname(fileURLToPath(import.meta.url));
let window, engine, store, syncTimer, heartbeatTimer;
const onlineWindows = new Set();
const hardened = { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged };
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('Aavin POS could not open', 'Secure local storage could not be initialized. Do not delete the local database. Restore access to the Windows account/key store and reopen the app.');
    app.quit();
  });
}
async function start() {
  app.setAccessibilitySupportEnabled(true);
  // Windows DPAPI/macOS Keychain are required. No plaintext fallback.
  if (!['win32', 'darwin'].includes(process.platform) || !await safeStorage.isAsyncEncryptionAvailable()) throw new Error('OS encryption unavailable.');
  const folder = app.getPath('userData'); await mkdir(folder, { recursive: true, mode: 0o700 });
  store = new Store(join(folder, 'counter.sqlite'), {
    seal: async value => (await safeStorage.encryptStringAsync(value)).toString('base64'),
    open: async value => (await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result
  });
  engine = new Engine(store, createCloud(JSON.parse(await readFile(join(root, 'public-config.json'), 'utf8'))));
  const contentRoot = join(root, 'ui-build');
  protocol.handle('pos', async request => {
    try {
      const path = assetPath(contentRoot, request.url), bytes = await readFile(path);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }[extname(path)] ?? 'application/octet-stream';
      return new Response(bytes, { headers: { 'Content-Type': type, 'Content-Security-Policy': desktopCsp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Aavin POS', submenu: [{ role: 'quit' }] }, { role: 'editMenu' }, { role: 'viewMenu', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] }]));
  window = new BrowserWindow({ title: 'Aavin POS Desktop', width: 1400, height: 950, minWidth: 800, minHeight: 600, backgroundColor: '#0d1117', webPreferences: { ...hardened, preload: join(root, 'preload.cjs') } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== COUNTER_URL) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.on('will-download', event => event.preventDefault());
  const actions = {
    view: () => engine.view(), configure: input => engine.configure(input), signIn: input => engine.signIn(input), unlock: input => engine.unlock(input),
    lock: () => engine.lock(), checkout: input => engine.checkout(input), acknowledge: input => engine.acknowledge(input), retry: () => engine.retry(),
    print: () => new Promise((resolve, reject) => window.webContents.print({ silent: false, printBackground: false }, (success, reason) => success ? resolve(true) : reject(new Error(reason === 'cancelled' ? 'Printing cancelled.' : 'Printing failed. The receipt is saved; you can retry.')))),
    onlineWorkspace: async () => {
      const origin = await store.get('backend');
      if (!origin) throw new Error('Set up the backend first.');
      // The existing web app has NO preload/bridge. It uses its original auth and ACLs.
      const online = new BrowserWindow({ title: 'Aavin POS · Online workspace', width: 1400, height: 950, backgroundColor: '#0d1117', webPreferences: { ...hardened, partition: 'online-workspace' } });
      onlineWindows.add(online);
      online.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      online.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
      online.webContents.on('will-attach-webview', event => event.preventDefault());
      online.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(false));
      online.webContents.session.setPermissionCheckHandler(() => false);
      online.on('closed', () => onlineWindows.delete(online));
      await online.loadURL(origin); return true;
    },
    backup: async () => {
      if (!engine.active || engine.active.role !== 'owner') throw new Error('Sign in online as owner to export a local backup.');
      const result = await dialog.showSaveDialog(window, { title: 'Back up encrypted counter data', defaultPath: `aavin-counter-${new Date().toISOString().slice(0, 10)}.sqlite`, filters: [{ name: 'Encrypted SQLite backup', extensions: ['sqlite'] }] });
      if (result.canceled || !result.filePath) return false;
      // SQLite online backup includes WAL and is consistent during ongoing sync.
      await backup(store.db, result.filePath); return true;
    }
  };
  // Serialize user commands; background sync has its own single-flight guard.
  let commands = Promise.resolve();
  for (const [name, action] of Object.entries(actions)) ipcMain.handle(`counter:${name}`, (event, payload) => {
    if (!trustedSender(event, window.webContents) || Buffer.byteLength(JSON.stringify(payload ?? null)) > 128000) return { ok: false, error: 'Request denied.' };
    const run = commands.then(async () => {
      try { return { ok: true, data: await action(payload) }; }
      catch (error) { return { ok: false, error: error instanceof Error && error.message.length < 250 ? error.message : 'Operation failed. Your saved bills are retained.' }; }
    });
    commands = run.catch(() => {}); return run;
  });
  await window.loadURL(COUNTER_URL);
  syncTimer = setInterval(() => { engine.sync().catch(() => { engine.connection = 'Local storage or sync error — reopen the app and retry.'; }); }, 15000);
  heartbeatTimer = setInterval(() => { engine.heartbeat().catch(() => {}); }, 60000);
  engine.startSync();
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { clearInterval(syncTimer); clearInterval(heartbeatTimer); });
