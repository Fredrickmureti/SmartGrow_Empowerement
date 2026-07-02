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

// `better-sqlite3` types only resolve inside the electron/ sub-package (where
// the dep is installed). The root tsconfig pulls this file in via the
// bluetooth barrel for renderer-side tests, so we use a structural shim
// matching the subset of the API we actually call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Statement = { run: (...args: any[]) => any; get: (...args: any[]) => any; all: (...args: any[]) => any[] };
type Database = { prepare: (sql: string) => Statement };
import type { DeviceRole } from '../types';

export interface KeyManagerLike {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export interface BtPairingRow {
  device_id: string;
  mac: string;
  name: string | null;
  role: DeviceRole;
  /** Decrypted in memory only. Never persisted in this shape. */
  link_key_plain: string | null;
  auto_reconnect: 0 | 1;
  paired_at: number;
  last_connected_at: number | null;
}

export interface BtPairingsStore {
  upsert(row: BtPairingRow): void;
  get(deviceId: string): BtPairingRow | null;
  list(): BtPairingRow[];
  delete(deviceId: string): void;
  markConnected(deviceId: string, ts: number): void;
}

// ── SQLite-backed implementation ─────────────────────────────────────────

type DbGetter = () => Database;

export class SqliteBtPairingsStore implements BtPairingsStore {
  constructor(private getDb: DbGetter, private keyManager: KeyManagerLike) {}

  upsert(row: BtPairingRow): void {
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

  get(deviceId: string): BtPairingRow | null {
    const r = this.getDb()
      .prepare('SELECT * FROM bt_pairings WHERE device_id = ? LIMIT 1')
      .get(deviceId) as RawRow | undefined;
    return r ? this.hydrate(r) : null;
  }

  list(): BtPairingRow[] {
    const rows = this.getDb().prepare('SELECT * FROM bt_pairings').all() as RawRow[];
    return rows.map((r) => this.hydrate(r));
  }

  delete(deviceId: string): void {
    this.getDb().prepare('DELETE FROM bt_pairings WHERE device_id = ?').run(deviceId);
  }

  markConnected(deviceId: string, ts: number): void {
    this.getDb().prepare('UPDATE bt_pairings SET last_connected_at = ? WHERE device_id = ?').run(ts, deviceId);
  }

  private hydrate(r: RawRow): BtPairingRow {
    let plain: string | null = null;
    if (r.link_key_encrypted) {
      try { plain = this.keyManager.decrypt(r.link_key_encrypted); }
      catch { plain = null; }
    }
    return {
      device_id: r.device_id,
      mac: r.mac,
      name: r.name,
      role: r.role as DeviceRole,
      link_key_plain: plain,
      auto_reconnect: r.auto_reconnect === 1 ? 1 : 0,
      paired_at: r.paired_at,
      last_connected_at: r.last_connected_at,
    };
  }
}

interface RawRow {
  device_id: string;
  mac: string;
  name: string | null;
  role: string;
  link_key_encrypted: string | null;
  auto_reconnect: number;
  paired_at: number;
  last_connected_at: number | null;
}

// ── In-memory implementation (tests + pre-DB-init) ───────────────────────

export class InMemoryBtPairingsStore implements BtPairingsStore {
  private rows = new Map<string, BtPairingRow>();
  /** Ciphertext snapshot so tests can assert link keys never sit plaintext on the store. */
  private cipherSnapshot = new Map<string, string | null>();

  constructor(private keyManager: KeyManagerLike) {}

  upsert(row: BtPairingRow): void {
    const cipher = row.link_key_plain ? this.keyManager.encrypt(row.link_key_plain) : null;
    this.cipherSnapshot.set(row.device_id, cipher);
    // Persist a hydrated copy with decrypted plain — mirrors SQLite hydrate() behaviour.
    this.rows.set(row.device_id, { ...row });
  }
  get(deviceId: string): BtPairingRow | null { return this.rows.get(deviceId) ?? null; }
  list(): BtPairingRow[] { return [...this.rows.values()]; }
  delete(deviceId: string): void {
    this.rows.delete(deviceId);
    this.cipherSnapshot.delete(deviceId);
  }
  markConnected(deviceId: string, ts: number): void {
    const r = this.rows.get(deviceId);
    if (r) r.last_connected_at = ts;
  }
  /** Test helper — never used in production. */
  _ciphertextFor(deviceId: string): string | null | undefined {
    return this.cipherSnapshot.get(deviceId);
  }
}