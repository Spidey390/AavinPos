import { resolve, sep, extname } from 'node:path';
export const COUNTER_URL = 'pos://counter/index.html';
export const desktopCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
export function assetPath(root, address) {
  const url = new URL(address);
  if (url.protocol !== 'pos:' || url.hostname !== 'counter' || url.username || url.password) throw new Error('Unknown local origin.');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) throw new Error('Invalid local asset.');
  const path = resolve(root, '.' + pathname);
  if (!path.startsWith(resolve(root) + sep) || !['.html', '.js', '.css', '.svg', '.json', '.png', '.woff2'].includes(extname(path))) throw new Error('Asset unavailable.');
  return path;
}
export function trustedSender(event, contents) {
  return event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === COUNTER_URL;
}
