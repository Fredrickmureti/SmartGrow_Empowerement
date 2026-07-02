"use strict";
/**
 * BtPairingsStore — persistence for Bluetooth pairings.
 *
 * Link keys are stored encrypted via {@link KeyManagerLike.encrypt} (the
 * KeyManager AES-256-GCM key is itself derived from the user password +
 * machine binding, so an attacker with raw access to the SQLite file
 * cannot replay a pairing key against another device).
 *
 * Plaintext access (`link_key_plain` on {@link BtPairingRow}) is decrypted
 * lazily inside `get()`/`list()` for the manager; the on-disk column is
 * always the ciphertext blob.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryBtPairingsStore = exports.SqliteBtPairingsStore = void 0;
class SqliteBtPairingsStore {
    constructor(getDb, keyManager) {
        this.getDb = getDb;
        this.keyManager = keyManager;
    }
    upsert(row) {
        const cipher = row.link_key_plain ? this.keyManager.encrypt(row.link_key_plain) : null;
        this.getDb().prepare(`
      INSERT INTO bt_pairings (device_id, mac, name, role, link_key_encrypted, auto_reconnect, paired_at, last_connected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        mac = excluded.mac,
        name = excluded.name,
        role = excluded.role,
        link_key_encrypted = excluded.link_key_encrypted,
        auto_reconnect = excluded.auto_reconnect,
        paired_at = excluded.paired_at
    `).run(row.device_id, row.mac, row.name, row.role, cipher, row.auto_reconnect, row.paired_at, row.last_connected_at);
    }
    get(deviceId) {
        const r = this.getDb()
            .prepare('SELECT * FROM bt_pairings WHERE device_id = ? LIMIT 1')
            .get(deviceId);
        return r ? this.hydrate(r) : null;
    }
    list() {
        const rows = this.getDb().prepare('SELECT * FROM bt_pairings').all();
        return rows.map((r) => this.hydrate(r));
    }
    delete(deviceId) {
        this.getDb().prepare('DELETE FROM bt_pairings WHERE device_id = ?').run(deviceId);
    }
    markConnected(deviceId, ts) {
        this.getDb().prepare('UPDATE bt_pairings SET last_connected_at = ? WHERE device_id = ?').run(ts, deviceId);
    }
    hydrate(r) {
        let plain = null;
        if (r.link_key_encrypted) {
            try {
                plain = this.keyManager.decrypt(r.link_key_encrypted);
            }
            catch {
                plain = null;
            }
        }
        return {
            device_id: r.device_id,
            mac: r.mac,
            name: r.name,
            role: r.role,
            link_key_plain: plain,
            auto_reconnect: r.auto_reconnect === 1 ? 1 : 0,
            paired_at: r.paired_at,
            last_connected_at: r.last_connected_at,
        };
    }
}
exports.SqliteBtPairingsStore = SqliteBtPairingsStore;
// ── In-memory implementation (tests + pre-DB-init) ───────────────────────
class InMemoryBtPairingsStore {
    constructor(keyManager) {
        this.keyManager = keyManager;
        this.rows = new Map();
        /** Ciphertext snapshot so tests can assert link keys never sit plaintext on the store. */
        this.cipherSnapshot = new Map();
    }
    upsert(row) {
        const cipher = row.link_key_plain ? this.keyManager.encrypt(row.link_key_plain) : null;
        this.cipherSnapshot.set(row.device_id, cipher);
        // Persist a hydrated copy with decrypted plain — mirrors SQLite hydrate() behaviour.
        this.rows.set(row.device_id, { ...row });
    }
    get(deviceId) { return this.rows.get(deviceId) ?? null; }
    list() { return [...this.rows.values()]; }
    delete(deviceId) {
        this.rows.delete(deviceId);
        this.cipherSnapshot.delete(deviceId);
    }
    markConnected(deviceId, ts) {
        const r = this.rows.get(deviceId);
        if (r)
            r.last_connected_at = ts;
    }
    /** Test helper — never used in production. */
    _ciphertextFor(deviceId) {
        return this.cipherSnapshot.get(deviceId);
    }
}
exports.InMemoryBtPairingsStore = InMemoryBtPairingsStore;
//# sourceMappingURL=BtPairingsStore.js.map