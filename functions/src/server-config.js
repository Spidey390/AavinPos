export function trustedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Configure valid API origins.'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*') || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('API origins require HTTPS, except loopback development.');
  return url.origin;
}
export function serverConfig(env) {
  const projectId = env.POS_PROJECT_ID;
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || projectId.startsWith('demo-')) throw new Error('Set POS_PROJECT_ID to the intended Firebase project.');
  if (env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_PROJECT_ID !== projectId) throw new Error('Browser and server Firebase projects must match.');
  if (env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST || env.FUNCTIONS_EMULATOR === 'true' || env.VITE_USE_FIREBASE_EMULATORS === 'true') throw new Error('The hosted server must not use emulator endpoints.');
  const port = Number(env.PORT || 3000), hosted = env.RENDER === 'true';
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
  const origins = (env.POS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(trustedOrigin);
  if (hosted) {
    if (!env.RENDER_EXTERNAL_URL?.startsWith('https://')) throw new Error('Render must provide its HTTPS site URL.');
    origins.push(trustedOrigin(env.RENDER_EXTERNAL_URL));
    if (!env.GOOGLE_APPLICATION_CREDENTIALS?.startsWith('/etc/secrets/')) throw new Error('Use a Render secret file for the backend service account.');
  } else if (!origins.length) origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  return { projectId, port, hosted, host: hosted ? '0.0.0.0' : '127.0.0.1', origins: [...new Set(origins)], allowRefunds: env.ENABLE_RECONCILED_REFUNDS === 'true', credentialFile: env.GOOGLE_APPLICATION_CREDENTIALS };
}
export function validateBuild(config, metadata) {
  if (metadata.projectId !== config.projectId || metadata.emulators !== false) throw new Error('Rebuild the browser for this Firebase project without emulators.');
}
export function validateHostedCredential(config, credential) {
  if (credential.type !== 'service_account' || credential.project_id !== config.projectId || typeof credential.private_key !== 'string' || typeof credential.client_email !== 'string') throw new Error('The service-account secret must belong to this Firebase project.');
}
