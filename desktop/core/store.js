import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

// Encrypted payloads include catalog, operator grants, refresh tokens and bills.
// SQLite WAL + FULL means a completed local receipt survives process restarts.
export class Store {
  constructor(filename, codec) {
    this.codec = codec;
    this.operatorWrites = Promise.resolve();
    this.saleWrites = Promise.resolve();
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operators (uid TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, uid TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sales_by_operator ON sales(uid, state);
      CREATE TABLE IF NOT EXISTS attendance (id INTEGER PRIMARY KEY, uid TEXT NOT NULL, payload TEXT NOT NULL);`);
  }
  async encode(value) { return this.codec.seal(JSON.stringify(value)); }
  async decode(value) { return value == null ? null : JSON.parse(await this.codec.open(value)); }
  async get(key) { return this.decode(this.db.prepare('SELECT payload FROM metadata WHERE key=?').get(key)?.payload); }
  async set(key, value) { this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key, await this.encode(value)); }
  async operator(uid) { return this.decode(this.db.prepare('SELECT payload FROM operators WHERE uid=?').get(uid)?.payload); }
  async operators() { return Promise.all(this.db.prepare('SELECT payload FROM operators').all().map(row => this.decode(row.payload))); }
  saveOperator(operator) {
    return this.writeOperator(operator.uid, () => operator);
  }
  writeOperator(uid, change) {
    const operation = this.operatorWrites.then(async () => {
      const operator = change(await this.operator(uid));
      this.db.prepare('INSERT INTO operators VALUES (?,?) ON CONFLICT(uid) DO UPDATE SET payload=excluded.payload').run(uid, await this.encode(operator));
      return operator;
    });
    this.operatorWrites = operation.catch(() => {}); return operation;
  }
  async sale(id) { return this.decode(this.db.prepare('SELECT payload FROM sales WHERE id=?').get(id)?.payload); }
  async sales(uid = null, { states = [], limit = null } = {}) {
    const conditions = [...(uid ? ['uid=?'] : []), ...(states.length ? [`state IN (${states.map(() => '?').join(',')})`] : [])];
    return Promise.all(this.db.prepare(`SELECT payload FROM sales ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY rowid DESC ${limit ? 'LIMIT ?' : ''}`).all(...(uid ? [uid] : []), ...states, ...(limit ? [limit] : [])).map(row => this.decode(row.payload)));
  }
  counts(uid = null) {
    const counts = { pending: 0, review: 0, synced: 0 };
    for (const row of this.db.prepare(`SELECT state,COUNT(*) AS count FROM sales ${uid ? 'WHERE uid=?' : ''} GROUP BY state`).all(...(uid ? [uid] : []))) counts[row.state] = row.count;
    return counts;
  }
  async insertSale(sale) { this.db.prepare('INSERT INTO sales VALUES (?,?,?,?)').run(sale.id, sale.uid, sale.state, await this.encode(sale)); }
  writeSale(id, change) {
    const operation = this.saleWrites.then(async () => {
      const sale = change(await this.sale(id));
      this.db.prepare('UPDATE sales SET state=?,payload=? WHERE id=? AND uid=?').run(sale.state, await this.encode(sale), sale.id, sale.uid);
    });
    this.saleWrites = operation.catch(() => {}); return operation;
  }
  updateSale(sale) { return this.writeSale(sale.id, () => sale); }
  async attendance(uid, event) { this.db.prepare('INSERT INTO attendance(uid,payload) VALUES (?,?)').run(uid, await this.encode(event)); }
  async close() { this.db.close(); }
}
