/**
 * SQLite Database Manager for Offline POS
 * Handles encrypted database initialization, migrations, and queries
 * Uses better-sqlite3 (aliased to better-sqlite3-multiple-ciphers) for SQLCipher encryption
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export interface DatabaseStats {
  size: number;
  tableCount: number;
  pendingSyncCount: number;
  lastVacuum: string | null;
}

export interface QueryResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  rowsAffected?: number;
}

class DatabaseManager {
  private db: Database.Database | null = null;
  private drizzleDb: ReturnType<typeof drizzle<typeof schema>> | null = null;
  private dbPath: string;
  private isInitialized = false;
  private encryptionKey: string | null = null;

  constructor() {
    const userDataPath = app.getPath('userData');
    const dbDir = path.join(userDataPath, 'database');
    
    // Ensure database directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    this.dbPath = path.join(dbDir, 'pos_offline.db');
  }

  /**
   * Initialize the encrypted SQLite database
   * @param encryptionKey - Key for SQLCipher encryption (derived from user credentials)
   */
  async initialize(encryptionKey: string): Promise<QueryResult<void>> {
    try {
      if (this.isInitialized && this.db) {
        console.log('Database already initialized');
        return { success: true };
      }

      this.encryptionKey = encryptionKey;

      // Open database with SQLCipher encryption
      this.db = new Database(this.dbPath);
      
      // Configure SQLCipher
      this.db.pragma(`key = '${this.sanitizeKey(encryptionKey)}'`);
      this.db.pragma('cipher_compatibility = 4'); // SQLCipher 4 compatibility
      this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for crash recovery
      this.db.pragma('synchronous = NORMAL'); // Balance between safety and speed
      this.db.pragma('foreign_keys = ON'); // Enforce foreign key constraints
      this.db.pragma('busy_timeout = 5000'); // 5 second timeout for locks

      // Verify encryption by running a simple query
      try {
        this.db.exec('SELECT count(*) FROM sqlite_master');
      } catch (e) {
        // If query fails, key is wrong or DB is corrupted
        this.db.close();
        this.db = null;
        return { 
          success: false, 
          error: 'Failed to decrypt database. Invalid key or corrupted database.' 
        };
      }

      // Initialize Drizzle ORM
      this.drizzleDb = drizzle(this.db, { schema });

      // Run migrations to create/update schema
      await this.runMigrations();

      this.isInitialized = true;
      console.log('Database initialized successfully at:', this.dbPath);
      
      return { success: true };
    } catch (error) {
      console.error('Failed to initialize database:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Run database migrations to create/update schema
   */
  private async runMigrations(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Create tables using raw SQL for initial setup
    // In production, use Drizzle migrations
    const createTablesSQL = this.getCreateTablesSQL();
    this.db.exec(createTablesSQL);

    // ── Idempotent column-add migrations for pre-existing DBs ───────
    // Wave B1 Step 2.5 (C3): hw_command_queue.next_attempt_at
    try {
      this.db.exec("ALTER TABLE hw_command_queue ADD COLUMN next_attempt_at INTEGER");
    } catch { /* column already exists — SQLite throws on duplicate */ }
  }


  /**
   * Get raw SQL for creating all tables
   * This is used for initial setup without migration files
   */
  private getCreateTablesSQL(): string {
    return `
      -- Organizations
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT DEFAULT 'KES',
        tax_settings TEXT,
        receipt_settings TEXT,
        synced_at TEXT,
        updated_at TEXT
      );

      -- Businesses
      CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        legal_name TEXT,
        logo_url TEXT,
        address TEXT,
        city TEXT,
        country TEXT,
        phone TEXT,
        email TEXT,
        tax_id TEXT,
        registration_number TEXT,
        base_currency TEXT DEFAULT 'KES',
        synced_at TEXT,
        updated_at TEXT
      );

      -- Products
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sku TEXT,
        description TEXT,
        selling_price REAL NOT NULL DEFAULT 0,
        cost_price REAL DEFAULT 0,
        tax_rate REAL DEFAULT 0,
        stock_quantity REAL DEFAULT 0,
        category TEXT,
        image_url TEXT,
        is_active INTEGER DEFAULT 1,
        track_inventory INTEGER DEFAULT 1,
        reorder_level REAL DEFAULT 0,
        unit_of_measure TEXT DEFAULT 'unit',
        synced_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS products_sku_idx ON products(sku);
      CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);
      CREATE INDEX IF NOT EXISTS products_org_idx ON products(organization_id);

      -- Product identifiers (canonical barcode/GTIN/PLU/SKU/alias mirror).
      -- The ONLY table read when resolving a scanned code locally. Phase D
      -- retired the legacy products.barcode column entirely: identity lives
      -- here, and `packaging_id` / `qty_in_base_uom` mirror the packaging
      -- level so an offline case scan still posts full base-unit content.
      CREATE TABLE IF NOT EXISTS product_identifiers (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        code TEXT NOT NULL,
        code_norm TEXT,
        kind TEXT,
        status TEXT DEFAULT 'active',
        valid_from TEXT,
        valid_to TEXT,
        is_primary INTEGER DEFAULT 0,
        packaging_id TEXT,
        qty_in_base_uom REAL DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS product_identifiers_code_idx ON product_identifiers(code);
      CREATE INDEX IF NOT EXISTS product_identifiers_code_norm_idx ON product_identifiers(code_norm);
      CREATE INDEX IF NOT EXISTS product_identifiers_product_idx ON product_identifiers(product_id);


      -- Contacts
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        type TEXT DEFAULT 'customer',
        company TEXT,
        address_line1 TEXT,
        address_line2 TEXT,
        city TEXT,
        country TEXT,
        tax_id TEXT,
        notes TEXT,
        is_active INTEGER DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS contacts_org_idx ON contacts(organization_id);
      CREATE INDEX IF NOT EXISTS contacts_type_idx ON contacts(type);
      CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts(phone);

      -- POS Registers
      CREATE TABLE IF NOT EXISTS pos_registers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        register_code TEXT NOT NULL,
        name TEXT NOT NULL,
        location TEXT,
        is_active INTEGER DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );

      -- POS Cashiers
      CREATE TABLE IF NOT EXISTS pos_cashiers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT,
        display_name TEXT NOT NULL,
        employee_number TEXT,
        pin_hash TEXT,
        permissions TEXT,
        is_active INTEGER DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );

      -- Tax Rates
      CREATE TABLE IF NOT EXISTS tax_rates (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        rate REAL NOT NULL,
        is_default INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );

      -- POS Discounts
      CREATE TABLE IF NOT EXISTS pos_discounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        discount_type TEXT NOT NULL,
        value REAL NOT NULL,
        min_purchase REAL,
        is_active INTEGER DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );

      -- Loyalty Programs
      CREATE TABLE IF NOT EXISTS loyalty_programs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        points_per_currency REAL DEFAULT 1,
        redemption_rate REAL DEFAULT 0.01,
        is_active INTEGER DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );

      -- Customer Loyalty
      CREATE TABLE IF NOT EXISTS customer_loyalty (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        program_id TEXT NOT NULL,
        points_balance REAL DEFAULT 0,
        points_earned_total REAL DEFAULT 0,
        points_redeemed_total REAL DEFAULT 0,
        total_spent REAL DEFAULT 0,
        visit_count INTEGER DEFAULT 0,
        current_tier TEXT,
        synced_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS loyalty_contact_idx ON customer_loyalty(contact_id);

      -- Notifications (cached from server)
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        business_id TEXT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        link TEXT,
        entity_type TEXT,
        entity_id TEXT,
        is_read INTEGER DEFAULT 0,
        is_dismissed INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0,
        expires_at TEXT,
        synced_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);
      CREATE INDEX IF NOT EXISTS notifications_read_idx ON notifications(is_read);
      CREATE INDEX IF NOT EXISTS notifications_category_idx ON notifications(category);

      -- Notification Preferences
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        category TEXT NOT NULL,
        email_enabled INTEGER DEFAULT 1,
        push_enabled INTEGER DEFAULT 1,
        in_app_enabled INTEGER DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notification_prefs_user_org_idx ON notification_preferences(user_id, organization_id);

      -- Notification Alert Settings
      CREATE TABLE IF NOT EXISTS notification_alert_settings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        business_id TEXT,
        low_stock_warning_threshold INTEGER DEFAULT 10,
        low_stock_critical_threshold INTEGER DEFAULT 5,
        out_of_stock_alert INTEGER DEFAULT 1,
        invoice_reminder_days_before INTEGER DEFAULT 7,
        overdue_reminder_frequency_days INTEGER DEFAULT 7,
        daily_digest_enabled INTEGER DEFAULT 0,
        weekly_digest_enabled INTEGER DEFAULT 1,
        synced_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notification_alert_settings_org_idx ON notification_alert_settings(organization_id);

      -- POS Shifts
      CREATE TABLE IF NOT EXISTS pos_shifts (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        organization_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        cashier_id TEXT NOT NULL,
        shift_number TEXT,
        opening_cash REAL NOT NULL DEFAULT 0,
        expected_cash REAL DEFAULT 0,
        actual_cash REAL,
        variance REAL,
        cash_sales REAL DEFAULT 0,
        card_sales REAL DEFAULT 0,
        mpesa_sales REAL DEFAULT 0,
        total_sales REAL DEFAULT 0,
        total_refunds REAL DEFAULT 0,
        transaction_count INTEGER DEFAULT 0,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        notes TEXT,
        status TEXT DEFAULT 'open',
        sync_status TEXT DEFAULT 'pending',
        synced_at TEXT,
        sync_error TEXT,
        local_version INTEGER DEFAULT 1,
        server_version INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS shifts_sync_idx ON pos_shifts(sync_status);
      CREATE INDEX IF NOT EXISTS shifts_date_idx ON pos_shifts(opened_at);

      -- POS Transactions
      CREATE TABLE IF NOT EXISTS pos_transactions (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        organization_id TEXT NOT NULL,
        transaction_number TEXT NOT NULL UNIQUE,
        register_id TEXT,
        shift_id TEXT,
        customer_id TEXT,
        subtotal REAL NOT NULL DEFAULT 0,
        tax_amount REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        discount_type TEXT,
        total REAL NOT NULL DEFAULT 0,
        payment_status TEXT DEFAULT 'pending',
        status TEXT DEFAULT 'completed',
        notes TEXT,
        etims_cu_number TEXT,
        etims_qr_code_url TEXT,
        etims_transmission_status TEXT,
        sync_status TEXT DEFAULT 'pending',
        synced_at TEXT,
        sync_error TEXT,
        local_version INTEGER DEFAULT 1,
        server_version INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        created_by TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS transactions_sync_idx ON pos_transactions(sync_status);
      CREATE INDEX IF NOT EXISTS transactions_date_idx ON pos_transactions(created_at);
      CREATE INDEX IF NOT EXISTS transactions_shift_idx ON pos_transactions(shift_id);

      -- POS Transaction Items
      CREATE TABLE IF NOT EXISTS pos_transaction_items (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        product_id TEXT,
        description TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL DEFAULT 0,
        discount_type TEXT,
        discount_value REAL DEFAULT 0,
        tax_rate REAL DEFAULT 0,
        tax_amount REAL DEFAULT 0,
        line_total REAL NOT NULL DEFAULT 0,
        cost_price REAL,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (transaction_id) REFERENCES pos_transactions(id)
      );
      CREATE INDEX IF NOT EXISTS items_transaction_idx ON pos_transaction_items(transaction_id);

      -- POS Transaction Payments
      CREATE TABLE IF NOT EXISTS pos_transaction_payments (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        reference TEXT,
        mpesa_receipt TEXT,
        change_given REAL DEFAULT 0,
        status TEXT DEFAULT 'completed',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (transaction_id) REFERENCES pos_transactions(id)
      );
      CREATE INDEX IF NOT EXISTS payments_transaction_idx ON pos_transaction_payments(transaction_id);

      -- POS Cash Movements
      CREATE TABLE IF NOT EXISTS pos_cash_movements (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        organization_id TEXT NOT NULL,
        shift_id TEXT NOT NULL,
        movement_type TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT,
        notes TEXT,
        performed_by TEXT,
        performed_at TEXT DEFAULT (datetime('now')),
        sync_status TEXT DEFAULT 'pending',
        synced_at TEXT,
        sync_error TEXT,
        FOREIGN KEY (shift_id) REFERENCES pos_shifts(id)
      );
      CREATE INDEX IF NOT EXISTS movements_shift_idx ON pos_cash_movements(shift_id);
      CREATE INDEX IF NOT EXISTS movements_sync_idx ON pos_cash_movements(sync_status);

      -- POS Returns
      CREATE TABLE IF NOT EXISTS pos_returns (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        organization_id TEXT NOT NULL,
        original_transaction_id TEXT NOT NULL,
        return_number TEXT NOT NULL,
        reason TEXT NOT NULL,
        refund_method TEXT,
        refund_amount REAL NOT NULL,
        status TEXT DEFAULT 'completed',
        processed_by TEXT,
        approved_by TEXT,
        sync_status TEXT DEFAULT 'pending',
        synced_at TEXT,
        sync_error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (original_transaction_id) REFERENCES pos_transactions(id)
      );
      CREATE INDEX IF NOT EXISTS returns_sync_idx ON pos_returns(sync_status);
      CREATE INDEX IF NOT EXISTS returns_original_tx_idx ON pos_returns(original_transaction_id);

      -- POS Return Items
      CREATE TABLE IF NOT EXISTS pos_return_items (
        id TEXT PRIMARY KEY,
        return_id TEXT NOT NULL,
        original_item_id TEXT,
        product_id TEXT,
        description TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit_price REAL NOT NULL,
        refund_amount REAL NOT NULL,
        restock INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (return_id) REFERENCES pos_returns(id)
      );
      CREATE INDEX IF NOT EXISTS return_items_return_idx ON pos_return_items(return_id);

      -- Stock Movements
      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        organization_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        movement_type TEXT NOT NULL,
        quantity REAL NOT NULL,
        reference_type TEXT,
        reference_id TEXT,
        notes TEXT,
        performed_by TEXT,
        sync_status TEXT DEFAULT 'pending',
        synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS stock_product_idx ON stock_movements(product_id);
      CREATE INDEX IF NOT EXISTS stock_sync_idx ON stock_movements(sync_status);

      -- Sync Metadata
      CREATE TABLE IF NOT EXISTS sync_metadata (
        table_name TEXT PRIMARY KEY,
        last_synced_at TEXT,
        last_server_timestamp TEXT,
        records_synced INTEGER DEFAULT 0,
        sync_direction TEXT NOT NULL
      );

      -- Offline Sessions
      CREATE TABLE IF NOT EXISTS offline_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        session_token_encrypted TEXT,
        organization_id TEXT NOT NULL,
        user_role TEXT,
        full_name TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON offline_sessions(user_id);

      -- Held Transactions
      CREATE TABLE IF NOT EXISTS held_transactions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        register_id TEXT,
        shift_id TEXT,
        customer_id TEXT,
        customer_name TEXT,
        items TEXT NOT NULL,
        subtotal REAL DEFAULT 0,
        tax_amount REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        total REAL DEFAULT 0,
        notes TEXT,
        held_by TEXT,
        held_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT
      );

      -- Audit Log
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        action TEXT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT,
        old_data TEXT,
        new_data TEXT,
        user_id TEXT,
        user_email TEXT,
        ip_address TEXT,
        user_agent TEXT,
        is_synced INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS audit_date_idx ON audit_log(created_at);
      CREATE INDEX IF NOT EXISTS audit_sync_idx ON audit_log(is_synced);
      CREATE INDEX IF NOT EXISTS audit_table_idx ON audit_log(table_name);

      -- Settings Cache
      CREATE TABLE IF NOT EXISTS settings_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        synced_at TEXT
      );

      -- Hardware orchestration: per-terminal device bindings (ADR-0014, Track 2)
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

      -- Hardware orchestration: durable per-device command queue (ADR-0014)
      CREATE TABLE IF NOT EXISTS hw_command_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_role TEXT NOT NULL,
        op TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        last_error TEXT,
        idempotency_key TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_attempt_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS hw_queue_role_status_idx
        ON hw_command_queue(device_role, status);
      CREATE INDEX IF NOT EXISTS hw_queue_role_status_due_idx
        ON hw_command_queue(device_role, status, next_attempt_at);
      CREATE UNIQUE INDEX IF NOT EXISTS hw_queue_idem_unique
        ON hw_command_queue(idempotency_key);
      -- Lightweight idempotent migration: add column to pre-existing DBs.


      -- Sale-completion saga outbox (ADR-0014)
      CREATE TABLE IF NOT EXISTS pos_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id TEXT NOT NULL,
        step TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pos_outbox_sale_step_unique
        ON pos_outbox(sale_id, step);
      CREATE INDEX IF NOT EXISTS pos_outbox_status_idx
        ON pos_outbox(status);

      -- Persistent sale commit payloads for crash recovery (ADR-0014 Track H3b)
      CREATE TABLE IF NOT EXISTS pos_sale_payloads (
        sale_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `;
  }

  /**
   * Sanitize encryption key to prevent SQL injection
   */
  private sanitizeKey(key: string): string {
    return key.replace(/'/g, "''");
  }

  /**
   * Get the Drizzle ORM instance
   */
  getDrizzle(): ReturnType<typeof drizzle<typeof schema>> {
    if (!this.drizzleDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.drizzleDb;
  }

  /**
   * Get the raw SQLite database instance
   */
  getDatabase(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a raw SQL query
   */
  execute<T = unknown>(sql: string, params: unknown[] = []): QueryResult<T[]> {
    try {
      if (!this.db) {
        return { success: false, error: 'Database not initialized' };
      }

      const stmt = this.db.prepare(sql);
      
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        const rows = stmt.all(...params) as T[];
        return { success: true, data: rows };
      } else {
        const result = stmt.run(...params);
        return { 
          success: true, 
          rowsAffected: result.changes,
          data: [] as T[]
        };
      }
    } catch (error) {
      console.error('Query execution failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Execute multiple queries in a transaction
   */
  executeTransaction<T = unknown>(queries: Array<{ sql: string; params?: unknown[] }>): QueryResult<T> {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    const transaction = this.db.transaction(() => {
      for (const query of queries) {
        const stmt = this.db!.prepare(query.sql);
        stmt.run(...(query.params || []));
      }
    });

    try {
      transaction();
      return { success: true };
    } catch (error) {
      console.error('Transaction failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Transaction failed' 
      };
    }
  }

  /**
   * Create a database backup
   */
  async backup(backupPath: string): Promise<QueryResult<void>> {
    try {
      if (!this.db) {
        return { success: false, error: 'Database not initialized' };
      }

      // Use SQLite backup API
      await this.db.backup(backupPath);
      
      return { success: true };
    } catch (error) {
      console.error('Backup failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Backup failed' 
      };
    }
  }

  /**
   * Optimize database by running VACUUM
   */
  vacuum(): QueryResult<void> {
    try {
      if (!this.db) {
        return { success: false, error: 'Database not initialized' };
      }

      this.db.exec('VACUUM');
      return { success: true };
    } catch (error) {
      console.error('Vacuum failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Vacuum failed' 
      };
    }
  }

  /**
   * Get database statistics
   */
  getStats(): QueryResult<DatabaseStats> {
    try {
      if (!this.db) {
        return { success: false, error: 'Database not initialized' };
      }

      // Get file size
      const stats = fs.statSync(this.dbPath);
      
      // Get table count
      const tableCountResult = this.db.prepare(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table'"
      ).get() as { count: number };

      // Get pending sync count
      const pendingResult = this.db.prepare(`
        SELECT 
          (SELECT count(*) FROM pos_transactions WHERE sync_status = 'pending') +
          (SELECT count(*) FROM pos_shifts WHERE sync_status = 'pending') +
          (SELECT count(*) FROM pos_cash_movements WHERE sync_status = 'pending') +
          (SELECT count(*) FROM pos_returns WHERE sync_status = 'pending')
        as count
      `).get() as { count: number };

      return {
        success: true,
        data: {
          size: stats.size,
          tableCount: tableCountResult.count,
          pendingSyncCount: pendingResult.count,
          lastVacuum: null, // Would need to track this separately
        },
      };
    } catch (error) {
      console.error('Failed to get stats:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to get stats' 
      };
    }
  }

  /**
   * Get database file path
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Check if database is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.db !== null;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.drizzleDb = null;
      this.isInitialized = false;
      console.log('Database closed');
    }
  }

  /**
   * Re-key the database with a new encryption key
   */
  rekey(newKey: string): QueryResult<void> {
    try {
      if (!this.db) {
        return { success: false, error: 'Database not initialized' };
      }

      this.db.pragma(`rekey = '${this.sanitizeKey(newKey)}'`);
      this.encryptionKey = newKey;
      
      return { success: true };
    } catch (error) {
      console.error('Rekey failed:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Rekey failed' 
      };
    }
  }
}

// Singleton instance
export const databaseManager = new DatabaseManager();
