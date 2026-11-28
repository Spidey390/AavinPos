export function backendOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter your trusted POS backend HTTPS address.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use a backend HTTPS origin without a path. HTTP is allowed only on this computer.');
  return url.origin;
}
export class CloudError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function decodeFields(fields = {}) {
  const decode = value => {
    if ('stringValue' in value) return value.stringValue;
    if ('booleanValue' in value) return value.booleanValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return value.doubleValue;
    if ('nullValue' in value) return null;
    if ('timestampValue' in value) return value.timestampValue;
    if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode);
    if ('mapValue' in value) return decodeFields(value.mapValue.fields);
    throw new Error('Unsupported catalog field.');
  };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decode(value)]));
}
export function createCloud(config, fetcher = fetch) {
  if (!/^[a-z0-9-]+$/.test(config.projectId) || !config.apiKey) throw new Error('Desktop Firebase registration is missing.');
  const base = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/`;
  async function json(url, options = {}) {
    let response;
    try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new CloudError('unavailable', 'Connection unavailable. Your saved bills will retry automatically.'); }
    const raw = await response.text();
    if (raw.length > 20 * 1024 * 1024) throw new CloudError('unavailable', 'The server response is too large.');
    let data;
    try { data = JSON.parse(raw); } catch { throw new CloudError('unavailable', 'The backend did not return POS data. Check its address.'); }
    if (!response.ok || data.error) {
      const status = String(data.error?.status ?? '').toLowerCase().replaceAll('_', '-');
      const rejectedSession = /(?:INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT)/.test(data.error?.message ?? '');
      const code = rejectedSession ? 'unauthenticated' : status || (response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'permission-denied' : 'unavailable');
      throw new CloudError(code, 'The server rejected this request. Reconnect or sign in again; saved bills are retained.');
    }
    return data;
  }
  const read = async (path, token) => decodeFields((await json(base + path, { headers: { Authorization: `Bearer ${token}` } })).fields);
  return {
    async signIn(email, password) {
      const result = await json(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
      return { uid: result.localId, email: result.email, token: result.idToken, refreshToken: result.refreshToken };
    },
    async refresh(refreshToken) {
      const result = await json(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.apiKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString() });
      return { uid: result.user_id, token: result.id_token, refreshToken: result.refresh_token };
    },
    async profile(uid, token) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error('Invalid operator.');
      const operator = await read(`operators/${uid}`, token);
      if (!operator.active || !['owner', 'staff'].includes(operator.role)) throw new CloudError('permission-denied', 'This operator has no active POS access.');
      const { workspace } = await read('posConfig/current', token);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspace)) throw new Error('The owner must initialize the workspace online.');
      return { ...operator, uid, workspace };
    },
    async catalog(workspace, token) {
      const settings = await read(`posWorkspaces/${workspace}/config/settings`, token);
      const products = [];
      let pageToken = '';
      do {
        const page = await json(base + `posWorkspaces/${workspace}/products?pageSize=300` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''), { headers: { Authorization: `Bearer ${token}` } });
        products.push(...(page.documents ?? []).map(document => ({ ...decodeFields(document.fields), id: document.name.split('/').at(-1) })));
        pageToken = page.nextPageToken;
        if (products.length > 10000) throw new Error('Catalog exceeds the desktop limit.');
      } while (pageToken);
      return { settings, products };
    },
    async call(origin, name, token, data) {
      if (!['checkout', 'recordStaffLogin', 'recordStaffLogout'].includes(name)) throw new Error('Unsupported desktop operation.');
      const result = await json(`${backendOrigin(origin)}/api/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      if (!Object.hasOwn(result, 'result') && !Object.hasOwn(result, 'data')) throw new CloudError('unavailable', 'Backend callable response missing.');
      return result.result ?? result.data;
    },
    async checkBackend(origin) {
      const info = await json(`${backendOrigin(origin)}/build-info.json`);
      if (info.projectId !== config.projectId || info.emulators !== false) throw new Error('The backend belongs to another project or uses emulators.');
    }
  };
}
