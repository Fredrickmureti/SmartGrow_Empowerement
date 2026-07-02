"use strict";
/**
 * SQLite-backed adapters for {@link QueueStore} and {@link OutboxStore}.
 *
 * Backed by the encrypted local DB (`hw_command_queue`, `pos_outbox` from
 * `electron/database/schema.ts`). Each method opens a fresh prepared
 * statement via the live `better-sqlite3` handle, so a database close /
 * re-open (e.g. user logout / login) is transparent to callers.
 *
 * The encrypted DB is only available after `database:initialize` succeeds.
 * Until then, callers should keep using the in-memory stores and swap
 * via `installSqliteHardwareStores()` in `main.ts`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqlitePaymentLogStore = exports.SqlitePayloadStore = exports.SqliteOutboxStore = exports.SqliteQueueStore = void 0;
// ── Queue store ───────────────────────────────────────────────────────────
class SqliteQueueStore {
    constructor(getDb) {
        this.getDb = getDb;
    }
    findByKey(key) {
        const row = this.getDb()
            .prepare('SELECT * FROM hw_command_queue WHERE idempotency_key = ? LIMIT 1')
            .get(key);
        return row ?? null;
    }
    insert(row) {
        const db = this.getDb();
        const info = db
            .prepare(`
        INSERT INTO hw_command_queue
          (device_role, op, payload, status, attempts, max_attempts,
           last_error, idempotency_key, result, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
            .run(row.device_role, row.op, row.payload, row.status, row.attempts, row.max_attempts, row.last_error, row.idempotency_key, row.result, row.created_at, row.updated_at);
        return { ...row, id: Number(info.lastInsertRowid) };
    }
    update(id, patch) {
        const keys = Object.keys(patch).filter((k) => k !== 'id');
        if (keys.length === 0)
            return;
        const sets = keys.map((k) => `${k} = ?`).join(', ');
        const values = keys.map((k) => patch[k]);
        this.getDb()
            .prepare(`UPDATE hw_command_queue SET ${sets} WHERE id = ?`)
            .run(...values, id);
    }
    nextPending(role) {
        const row = this.getDb()
            .prepare(`
        SELECT * FROM hw_command_queue
        WHERE device_role = ? AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      `)
            .get(role);
        return row ?? null;
    }
    listByStatus(status, limit = 100) {
        return this.getDb()
            .prepare('SELECT * FROM hw_command_queue WHERE status = ? ORDER BY id DESC LIMIT ?')
            .all(status, limit);
    }
}
exports.SqliteQueueStore = SqliteQueueStore;
// ── Outbox store ──────────────────────────────────────────────────────────
class SqliteOutboxStore {
    constructor(getDb) {
        this.getDb = getDb;
    }
    upsert(row) {
        const db = this.getDb();
        const existing = db
            .prepare('SELECT * FROM pos_outbox WHERE sale_id = ? AND step = ? LIMIT 1')
            .get(row.sale_id, row.step);
        if (existing)
            return existing;
        const info = db
            .prepare(`
        INSERT INTO pos_outbox
          (sale_id, step, status, attempts, last_error, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
            .run(row.sale_id, row.step, row.status, row.attempts, row.last_error, row.created_at);
        return { ...row, id: Number(info.lastInsertRowid) };
    }
    update(saleId, step, patch) {
        const keys = Object.keys(patch).filter((k) => k !== 'id' && k !== 'sale_id' && k !== 'step');
        if (keys.length === 0)
            return;
        const sets = keys.map((k) => `${k} = ?`).join(', ');
        const values = keys.map((k) => patch[k]);
        this.getDb()
            .prepare(`UPDATE pos_outbox SET ${sets} WHERE sale_id = ? AND step = ?`)
            .run(...values, saleId, step);
    }
    listUnfinished() {
        return this.getDb()
            .prepare(`
        SELECT * FROM pos_outbox
        WHERE status IN ('pending', 'running', 'failed')
        ORDER BY created_at ASC
      `)
            .all();
    }
    findOne(saleId, step) {
        const row = this.getDb()
            .prepare('SELECT * FROM pos_outbox WHERE sale_id = ? AND step = ? LIMIT 1')
            .get(saleId, step);
        return row ?? null;
    }
}
exports.SqliteOutboxStore = SqliteOutboxStore;
// ── Payload store (ADR-0014 Track H3b) ────────────────────────────────────
//
// Persists the full `SagaCommitPayload` so crash-recovery has the receipt/
// drawer/display/gl payloads needed to re-enqueue saga steps. Without this,
// the outbox rows survive a crash but the data they reference is gone.
class SqlitePayloadStore {
    constructor(getDb) {
        this.getDb = getDb;
    }
    put(saleId, payload) {
        this.getDb()
            .prepare(`
        INSERT INTO pos_sale_payloads (sale_id, payload_json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(sale_id) DO NOTHING
      `)
            .run(saleId, JSON.stringify(payload), Date.now());
    }
    get(saleId) {
        const row = this.getDb()
            .prepare('SELECT payload_json FROM pos_sale_payloads WHERE sale_id = ? LIMIT 1')
            .get(saleId);
        if (!row)
            return null;
        try {
            return JSON.parse(row.payload_json);
        }
        catch {
            return null;
        }
    }
    delete(saleId) {
        this.getDb().prepare('DELETE FROM pos_sale_payloads WHERE sale_id = ?').run(saleId);
    }
    all() {
        const rows = this.getDb()
            .prepare('SELECT sale_id, payload_json FROM pos_sale_payloads')
            .all();
        const out = new Map();
        for (const r of rows) {
            try {
                out.set(r.sale_id, JSON.parse(r.payload_json));
            }
            catch { /* skip corrupt */ }
        }
        return out;
    }
}
exports.SqlitePayloadStore = SqlitePayloadStore;
// ── Payment terminal log store (ADR-0014 Track P) ────────────────────────
class SqlitePaymentLogStore {
    constructor(getDb) {
        this.getDb = getDb;
    }
    findByIdempotency(key) {
        const r = this.getDb()
            .prepare('SELECT * FROM pos_payment_terminal_log WHERE idempotency_key = ? LIMIT 1')
            .get(key);
        return r ?? null;
    }
    insert(row) {
        const info = this.getDb().prepare(`
      INSERT INTO pos_payment_terminal_log
        (txn_id, pos_order_id, vendor, state, amount_cents, currency, auth_id,
         vendor_txn_id, idempotency_key, error, auto_capture, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.txn_id, row.pos_order_id, row.vendor, row.state, row.amount_cents, row.currency, row.auth_id, row.vendor_txn_id, row.idempotency_key, row.error, row.auto_capture, row.created_at, row.updated_at);
        return { ...row, id: Number(info.lastInsertRowid) };
    }
    update(id, patch) {
        const keys = Object.keys(patch).filter((k) => k !== 'id');
        if (keys.length === 0)
            return;
        const sets = keys.map((k) => `${k} = ?`).join(', ');
        const values = keys.map((k) => patch[k]);
        this.getDb().prepare(`UPDATE pos_payment_terminal_log SET ${sets} WHERE id = ?`).run(...values, id);
    }
    listApprovedOlderThan(cutoffMs) {
        return this.getDb().prepare(`
      SELECT * FROM pos_payment_terminal_log
      WHERE state = 'approved' AND auto_capture = 1 AND updated_at <= ?
      ORDER BY updated_at ASC
    `).all(cutoffMs);
    }
    findByAuthId(authId) {
        const r = this.getDb()
            .prepare('SELECT * FROM pos_payment_terminal_log WHERE auth_id = ? LIMIT 1')
            .get(authId);
        return r ?? null;
    }
}
exports.SqlitePaymentLogStore = SqlitePaymentLogStore;
//# sourceMappingURL=SqliteStores.js.map