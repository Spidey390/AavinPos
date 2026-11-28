import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { estimate, money, validateSale } from './billing.js';
import { backendOrigin, CloudError } from './cloud.js';

const LEASE_MS = 24 * 60 * 60 * 1000;
const hashPin = (pin, salt) => scryptSync(pin, salt, 32).toString('hex');
const pinValid = pin => typeof pin === 'string' && pin.length >= 8 && pin.length <= 128;
export class Engine {
  constructor(store, cloud, { clock = Date.now } = {}) {
    this.store = store; this.cloud = cloud; this.clock = clock;
    this.active = null; this.busy = false; this.checkoutBusy = false;
    this.connection = 'Not checked'; this.failedSignIns = 0; this.signInAfter = 0;
  }
  startSync() {
    void this.sync().catch(() => { this.connection = 'Local storage or sync error. Reopen the app and retry.'; });
  }
  async configure({ origin }) {
    if ((await this.store.operators()).length && this.active?.role !== 'owner') throw new Error('Sign in as owner to change the backend.');
    const normalized = backendOrigin(origin);
    const counts = this.store.counts();
    if ((counts.pending || counts.review) && normalized !== (await this.store.get('backend'))) throw new Error('Resolve pending bills before changing the backend.');
    await this.cloud.checkBackend(normalized);
    await this.store.set('backend', normalized);
    return this.view();
  }
  async signIn({ email, password, pin }) {
    if (this.clock() < this.signInAfter) throw new Error('Wait 30 seconds before signing in again.');
    if (typeof email !== 'string' || email.length > 120 || typeof password !== 'string' || password.length > 128 || !pinValid(pin)) throw new Error('Enter email, password, and an offline passphrase of 8–128 characters.');
    if (!await this.store.get('backend')) throw new Error('Set up the trusted backend first.');
    let session;
    try { session = await this.cloud.signIn(email.trim(), password); }
    catch (error) { if (++this.failedSignIns >= 5) this.signInAfter = this.clock() + 30000; throw error; }
    const profile = await this.cloud.profile(session.uid, session.token);
    const catalog = profile.role === 'staff' ? await this.cloud.catalog(profile.workspace, session.token) : { products: [], settings: {} };
    const salt = randomBytes(16).toString('hex');
    const operator = { ...profile, email: session.email, refreshToken: session.refreshToken, salt, pinHash: hashPin(pin, salt), catalog, verifiedAt: this.clock(), highWater: this.clock(), failures: 0, lockedUntil: 0 };
    await this.store.saveOperator(operator);
    this.active = operator; this.failedSignIns = 0;
    this.connection = 'Connected';
    await this.store.attendance(operator.uid, { event: 'unlock', deviceTime: new Date(this.clock()).toISOString(), verification: 'device-only' });
    await this.heartbeat().catch(() => {});
    this.startSync();
    return this.view();
  }
  async unlock({ email, pin }) {
    if (typeof email !== 'string' || !pinValid(pin)) throw new Error('Enter your email and offline passphrase.');
    const operator = (await this.store.operators()).find(operator => operator.email?.toLowerCase() === email.toLowerCase().trim());
    if (!operator || operator.role !== 'staff') throw new Error('This staff account needs an online sign-in first. Owners require internet access.');
    if (operator.revoked || this.clock() < operator.lockedUntil) throw new Error('Access is locked. Sign in online or wait for the lockout to end.');
    const candidate = Buffer.from(hashPin(pin, operator.salt), 'hex');
    if (!timingSafeEqual(candidate, Buffer.from(operator.pinHash, 'hex'))) {
      await this.store.writeOperator(operator.uid, current => ({ ...current, failures: current.failures + 1, lockedUntil: current.failures + 1 >= 5 ? this.clock() + 30000 : current.lockedUntil }));
      throw new Error('Incorrect offline passphrase.');
    }
    await this.checkLease(operator);
    await this.store.writeOperator(operator.uid, current => ({ ...current, failures: 0 }));
    this.active = operator;
    await this.store.attendance(operator.uid, { event: 'unlock', deviceTime: new Date(this.clock()).toISOString(), verification: 'device-only' });
    this.startSync();
    return this.view();
  }
  async checkLease(operator) {
    if (operator.revoked || this.clock() < operator.highWater - 300000 || this.clock() > operator.verifiedAt + LEASE_MS) throw new Error('Offline access expired or the clock changed. Sign in online to renew access.');
    await this.store.writeOperator(operator.uid, current => ({ ...current, highWater: Math.max(current.highWater, this.clock()) }));
  }
  async lock() {
    const current = this.active;
    this.active = null;
    if (current) {
      await this.store.attendance(current.uid, { event: 'lock', deviceTime: new Date(this.clock()).toISOString(), verification: 'device-only' });
      if (current.role === 'staff') {
        // Lock the screen immediately even if the server is unreachable/asleep.
        void (async () => { const session = await this.cloud.refresh(current.refreshToken); await this.cloud.call(await this.store.get('backend'), 'recordStaffLogout', session.token, {}); })().catch(() => {});
      }
    }
    return this.view();
  }
  async heartbeat() {
    if (this.active?.role !== 'staff') return;
    const uid = this.active.uid;
    const operator = await this.store.operator(uid);
    try {
      const session = await this.cloud.refresh(operator.refreshToken);
      if (session.uid !== uid) throw new CloudError('permission-denied', 'Operator identity changed.');
      const profile = await this.cloud.profile(uid, session.token);
      if (profile.role !== 'staff' || profile.workspace !== operator.workspace) throw new CloudError('permission-denied', 'Operator access changed.');
      await this.cloud.call(await this.store.get('backend'), 'recordStaffLogin', session.token, {});
      this.connection = 'Connected';
      await this.store.writeOperator(uid, current => current.refreshToken === operator.refreshToken ? { ...current, refreshToken: session.refreshToken } : current);
    } catch (error) {
      if (['permission-denied', 'unauthenticated'].includes(error.code)) {
        await this.store.writeOperator(uid, current => current.refreshToken === operator.refreshToken ? { ...current, revoked: true } : current);
      }
      throw error;
    }
  }
  async checkout(input) {
    validateSale(input);
    if (this.checkoutBusy) throw new Error('A bill is already being saved.');
    this.checkoutBusy = true;
    try {
      const operator = this.active && await this.store.operator(this.active.uid);
      if (!operator || operator.role !== 'staff') throw new Error('Unlock a staff account before billing.');
      const existing = await this.store.sale(input.id);
      if (existing) {
        if (existing.uid !== operator.uid || JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('This bill ID was already used.');
        return existing;
      }
      await this.checkLease(operator);
      if ((await this.store.sales(operator.uid, { limit: 1 })).some(sale => sale.acknowledged === false)) throw new Error('Open and close the last saved receipt before starting another bill.');
      const bill = estimate(operator.catalog.products, input.items);
      if (money(input.amountReceived) < money(bill.total)) throw new Error('Cash received must cover the bill.');
      const device = await this.store.get('device') ?? randomUUID();
      await this.store.set('device', device);
      const reference = `LOCAL-${device.slice(0, 8)}-${input.id}`;
      const capturedAt = new Date(this.clock()).toISOString();
      const sale = { id: input.id, uid: operator.uid, state: 'pending', attempts: 0, retryAt: 0, input, acknowledged: false, amountReceived: input.amountReceived, change: (money(input.amountReceived) - money(bill.total)) / 100,
        localReceiptNo: reference, capturedAt, cashierName: operator.name || operator.email, merchant: operator.catalog.settings, ...bill,
        request: { workspace: operator.workspace, idempotencyKey: input.id, items: input.items, customerId: null, tableId: null, tableRevision: null,
          channel: input.channel, discountPercent: 0, paymentMethod: 'Cash', amountReceived: input.amountReceived, splitBreakdown: null, referenceNo: '', expectedTotal: bill.total,
          offlineReceipt: { reference, capturedAt } } };
      await this.store.insertSale(sale);
      this.startSync();
      return sale;
    } finally { this.checkoutBusy = false; }
  }
  async sync() {
    if (this.busy) return;
    this.busy = true;
    try {
      const origin = await this.store.get('backend');
      if (!origin) return;
      const sessions = new Map();
      // Bound uploads per poll to leave room for interactive API requests.
      for (const sale of (await this.store.sales(null, { states: ['pending'], limit: 10 })).reverse()) {
        if (sale.state !== 'pending' || sale.retryAt > this.clock()) continue;
        try {
          let session = sessions.get(sale.uid);
          if (!session) {
            const operator = await this.store.operator(sale.uid);
            if (!operator || operator.revoked) throw new CloudError('unauthenticated', 'Sign in online again.');
            session = await this.cloud.refresh(operator.refreshToken);
            if (session.uid !== sale.uid) throw new CloudError('permission-denied', 'Operator identity changed.');
            await this.store.writeOperator(sale.uid, current => current.refreshToken === operator.refreshToken ? { ...current, refreshToken: session.refreshToken } : current);
            sessions.set(sale.uid, session);
          }
          const result = await this.cloud.call(origin, 'checkout', session.token, sale.request);
          if (result?.id !== sale.id || result?.cashierUid !== sale.uid || result?.financialSchema !== 2 || money(result.total) !== money(sale.total)) throw new CloudError('unavailable', 'The server acknowledgement could not be verified.');
          sale.state = 'synced'; sale.serverInvoice = result; sale.lastError = ''; sale.syncedAt = new Date(this.clock()).toISOString();
          this.connection = 'Connected';
        } catch (error) {
          sale.attempts++;
          sale.lastError = error.code === 'failed-precondition' ? 'Catalog, workspace or setup changed. Owner review required; cash has already been collected.' : error.code === 'permission-denied' || error.code === 'unauthenticated' ? 'Access rejected. Sign in online again; this bill is retained.' : 'Sync interrupted. This bill is retained and will retry.';
          const permanent = ['invalid-argument', 'failed-precondition', 'already-exists', 'permission-denied', 'unauthenticated'].includes(error.code);
          sale.state = permanent ? 'review' : 'pending';
          sale.retryAt = this.clock() + Math.min(300000, 1000 * 2 ** Math.min(sale.attempts, 9));
          this.connection = permanent ? 'Review required' : 'Waiting for connection';
          if (['permission-denied', 'unauthenticated'].includes(error.code)) {
            const operator = await this.store.operator(sale.uid);
            if (operator) await this.store.writeOperator(sale.uid, current => ({ ...current, revoked: true }));
          }
        }
        // Retain the exact request and idempotency key even after uncertain timeouts.
        await this.store.writeSale(sale.id, current => ({ ...sale, acknowledged: current.acknowledged }));
      }
    } finally { this.busy = false; }
  }
  async retry() {
    if (!this.active) throw new Error('Sign in to retry saved bills.');
    for (const sale of await this.store.sales(this.active.role === 'owner' ? null : this.active.uid, { states: ['pending', 'review'] })) {
      if (sale.state === 'synced') continue;
      await this.store.writeSale(sale.id, current => current.state === 'synced' ? current : { ...current, state: 'pending', retryAt: 0 });
    }
    await this.sync(); return this.view();
  }
  async acknowledge({ id }) {
    const sale = await this.store.sale(id);
    if (!sale || !this.active || (sale.uid !== this.active.uid && this.active.role !== 'owner')) throw new Error('Receipt access denied.');
    // Only the acknowledgement bit changes; never rewrite a concurrent sync result.
    await this.store.writeSale(id, current => ({ ...current, acknowledged: true }));
    return true;
  }
  async view() {
    const active = this.active && await this.store.operator(this.active.uid);
    const uid = active?.role === 'owner' ? null : active?.uid;
    const all = active ? await this.store.sales(uid, { limit: 100 }) : [];
    return { backend: await this.store.get('backend') ?? '', connection: this.connection,
      operator: active ? { uid: active.uid, name: active.name, email: active.email, role: active.role, revoked: Boolean(active.revoked), offlineUntil: active.verifiedAt + LEASE_MS } : null,
      catalog: active?.role === 'staff' ? active.catalog : null,
      sales: all.slice(0, 100).map(({ request, input, ...sale }) => sale),
      counts: active ? this.store.counts(uid) : { pending: 0, review: 0, synced: 0 } };
  }
}
