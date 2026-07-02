"use strict";
/**
 * pos_device_assignments — per-terminal device bindings.
 *
 * The DeviceManager bootstraps from this table: every enabled row becomes
 * a registered op-handler on the CommandRouter. Without this, `pos:exec`
 * returns "unknown op" for every saga step (Track 2 of ADR-0014).
 *
 * Schema is created by DatabaseManager.runMigrations() on `db:initialize`.
 * This store opens fresh prepared statements per call so a close / re-open
 * (logout / login) is transparent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.POS_DEVICE_ASSIGNMENTS_SQL = exports.AssignmentStore = void 0;
class AssignmentStore {
    constructor(getDb) {
        this.getDb = getDb;
    }
    /**
     * Active assignments for a terminal. NULL terminal_id rows are "global"
     * defaults (used when no per-terminal binding exists yet).
     */
    loadActive(terminalId) {
        const db = this.getDb();
        if (terminalId) {
            return db
                .prepare(`
          SELECT * FROM pos_device_assignments
          WHERE enabled = 1
            AND (terminal_id = ? OR terminal_id IS NULL)
          ORDER BY (terminal_id IS NULL) ASC, role ASC
        `)
                .all(terminalId);
        }
        return db
            .prepare(`SELECT * FROM pos_device_assignments WHERE enabled = 1 ORDER BY role ASC`)
            .all();
    }
    list() {
        return this.getDb()
            .prepare(`SELECT * FROM pos_device_assignments ORDER BY role ASC, updated_at DESC`)
            .all();
    }
    /** Upsert by (terminal_id, role) — one device per role per terminal. */
    upsert(input) {
        const db = this.getDb();
        const now = Date.now();
        const terminalId = input.terminalId ?? null;
        const enabled = input.enabled === false ? 0 : 1;
        const configJson = JSON.stringify(input.config ?? {});
        const existing = db
            .prepare(`
        SELECT * FROM pos_device_assignments
        WHERE role = ? AND COALESCE(terminal_id, '') = COALESCE(?, '')
        LIMIT 1
      `)
            .get(input.role, terminalId);
        if (existing) {
            db.prepare(`
        UPDATE pos_device_assignments
        SET transport = ?, driver = ?, config_json = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(input.transport, input.driver, configJson, enabled, now, existing.id);
            return { ...existing, transport: input.transport, driver: input.driver,
                config_json: configJson, enabled, updated_at: now };
        }
        const info = db.prepare(`
      INSERT INTO pos_device_assignments
        (terminal_id, role, transport, driver, config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(terminalId, input.role, input.transport, input.driver, configJson, enabled, now, now);
        return {
            id: Number(info.lastInsertRowid),
            terminal_id: terminalId,
            role: input.role,
            transport: input.transport,
            driver: input.driver,
            config_json: configJson,
            enabled,
            created_at: now,
            updated_at: now,
        };
    }
    remove(id) {
        const info = this.getDb()
            .prepare('DELETE FROM pos_device_assignments WHERE id = ?')
            .run(id);
        return info.changes > 0;
    }
}
exports.AssignmentStore = AssignmentStore;
/** Idempotent CREATE — appended to DatabaseManager.getCreateTablesSQL(). */
exports.POS_DEVICE_ASSIGNMENTS_SQL = `
  CREATE TABLE IF NOT EXISTS pos_device_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    terminal_id TEXT,
    role TEXT NOT NULL,
    transport TEXT NOT NULL,
    driver TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pos_device_assignments_role_idx
    ON pos_device_assignments(role, enabled);
  CREATE UNIQUE INDEX IF NOT EXISTS pos_device_assignments_role_terminal_uniq
    ON pos_device_assignments(role, COALESCE(terminal_id, ''));
`;
//# sourceMappingURL=store.js.map