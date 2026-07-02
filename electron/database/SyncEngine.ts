/**
 * SQLite Sync Engine
 * Handles bidirectional synchronization between local SQLite and Supabase
 */

import { databaseManager } from './DatabaseManager';
import { auditLogger } from './AuditLogger';
import { v4 as uuidv4 } from 'uuid';

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';
export type SyncDirection = 'up' | 'down' | 'both';

export interface SyncResult {
  success: boolean;
  recordsPulled: number;
  recordsPushed: number;
  conflicts: ConflictRecord[];
  errors: SyncError[];
  duration: number;
}

export interface SyncError {
  table: string;
  recordId: string;
  error: string;
  timestamp: string;
}

export interface ConflictRecord {
  table: string;
  recordId: string;
  localVersion: number;
  serverVersion: number;
  localData: unknown;
  serverData: unknown;
  detectedAt: string;
}

export interface SyncTableConfig {
  tableName: string;
  supabaseTable: string;
  direction: SyncDirection;
  primaryKey: string;
  syncFields: string[];
  timestampField: string;
  conflictStrategy: 'server_wins' | 'client_wins' | 'manual' | 'merge';
}

// Tables configuration for sync
const SYNC_TABLES: SyncTableConfig[] = [
  // Reference data - server wins (pulled from server)
  {
    tableName: 'organizations',
    supabaseTable: 'organizations',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['name', 'currency', 'tax_settings', 'receipt_settings'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'businesses',
    supabaseTable: 'businesses',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['name', 'legal_name', 'logo_url', 'address', 'city', 'country', 'phone', 'email', 'tax_id', 'base_currency'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'branches',
    supabaseTable: 'branches',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['business_id', 'name', 'code', 'is_headquarters', 'address', 'city', 'state', 'country', 'phone', 'email', 'postal_code', 'is_active'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'user_branch_assignments',
    supabaseTable: 'user_branch_assignments',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['user_id', 'business_id', 'branch_id', 'is_primary', 'can_view', 'can_manage'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'products',
    supabaseTable: 'products',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['business_id', 'name', 'sku', 'barcode', 'description', 'selling_price', 'cost_price', 'tax_rate', 'stock_quantity', 'category', 'image_url', 'is_active', 'track_inventory', 'reorder_level', 'unit_of_measure'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'contacts',
    supabaseTable: 'contacts',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['business_id', 'name', 'email', 'phone', 'type', 'company', 'address_line1', 'city', 'country', 'tax_id', 'is_active'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'pos_registers',
    supabaseTable: 'pos_registers',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['business_id', 'branch_id', 'register_code', 'name', 'location', 'is_active'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'pos_cashiers',
    supabaseTable: 'pos_cashiers',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['user_id', 'display_name', 'employee_number', 'pin_hash', 'permissions', 'is_active'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'tax_rates',
    supabaseTable: 'tax_rates',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['name', 'rate', 'is_default', 'is_active'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'pos_discounts',
    supabaseTable: 'pos_discounts',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['name', 'discount_type', 'value', 'min_purchase', 'is_active'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  // POS Settings - pulled from server for receipt settings, etc.
  {
    tableName: 'pos_settings',
    supabaseTable: 'pos_settings',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['register_id', 'setting_key', 'setting_value'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  // Platform settings - pulled from server for M-Pesa environment, etc.
  {
    tableName: 'platform_settings',
    supabaseTable: 'platform_settings',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['setting_key', 'setting_value', 'setting_type', 'description'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  // Notification data - pulled from server for offline access
  {
    tableName: 'notifications',
    supabaseTable: 'notifications',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['business_id', 'user_id', 'type', 'category', 'title', 'message', 'link', 'entity_type', 'entity_id', 'is_read', 'is_dismissed', 'priority', 'expires_at'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'notification_preferences',
    supabaseTable: 'notification_preferences',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['user_id', 'category', 'email_enabled', 'push_enabled', 'in_app_enabled'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  {
    tableName: 'notification_alert_settings',
    supabaseTable: 'notification_alert_settings',
    direction: 'down',
    primaryKey: 'id',
    syncFields: ['business_id', 'low_stock_warning_threshold', 'low_stock_critical_threshold', 'out_of_stock_alert', 'invoice_reminder_days_before', 'overdue_reminder_frequency_days', 'daily_digest_enabled', 'weekly_digest_enabled'],
    timestampField: 'updated_at',
    conflictStrategy: 'server_wins',
  },
  // Transaction data - manual conflict resolution (pushed to server)
  {
    tableName: 'pos_shifts',
    supabaseTable: 'pos_shifts',
    direction: 'up',
    primaryKey: 'id',
    syncFields: ['business_id', 'branch_id', 'register_id', 'cashier_id', 'shift_number', 'opening_cash', 'expected_cash', 'actual_cash', 'variance', 'cash_sales', 'card_sales', 'mpesa_sales', 'total_sales', 'total_refunds', 'transaction_count', 'opened_at', 'closed_at', 'notes', 'status'],
    timestampField: 'updated_at',
    conflictStrategy: 'manual',
  },
  {
    tableName: 'pos_transactions',
    supabaseTable: 'pos_transactions',
    direction: 'up',
    primaryKey: 'id',
    syncFields: ['business_id', 'branch_id', 'transaction_number', 'register_id', 'shift_id', 'customer_id', 'subtotal', 'tax_amount', 'discount_amount', 'discount_type', 'total', 'payment_status', 'status', 'notes', 'created_by'],
    timestampField: 'created_at',
    conflictStrategy: 'manual',
  },
  // Transaction items - pushed to server with parent transaction
  {
    tableName: 'pos_transaction_items',
    supabaseTable: 'pos_transaction_items',
    direction: 'up',
    primaryKey: 'id',
    syncFields: ['transaction_id', 'product_id', 'description', 'quantity', 'unit_price', 'discount_type', 'discount_value', 'tax_rate', 'tax_amount', 'line_total', 'cost_price', 'sort_order'],
    timestampField: 'created_at',
    conflictStrategy: 'manual',
  },
  // Transaction payments - pushed to server (includes M-Pesa receipts)
  {
    tableName: 'pos_transaction_payments',
    supabaseTable: 'pos_transaction_payments',
    direction: 'up',
    primaryKey: 'id',
    syncFields: ['transaction_id', 'payment_method', 'amount', 'reference', 'mpesa_receipt', 'change_given', 'status'],
    timestampField: 'created_at',
    conflictStrategy: 'manual',
  },
  {
    tableName: 'pos_cash_movements',
    supabaseTable: 'pos_cash_movements',
    direction: 'up',
    primaryKey: 'id',
    syncFields: ['shift_id', 'movement_type', 'amount', 'reason', 'notes', 'performed_by', 'performed_at'],
    timestampField: 'performed_at',
    conflictStrategy: 'manual',
  },
  {
    tableName: 'pos_returns',
    supabaseTable: 'pos_returns',
    direction: 'up',
    primaryKey: 'id',
    syncFields: ['original_transaction_id', 'return_number', 'reason', 'refund_method', 'refund_amount', 'status', 'processed_by', 'approved_by'],
    timestampField: 'created_at',
    conflictStrategy: 'manual',
  },
];

class SyncEngine {
  private isSyncing = false;
  private organizationId: string | null = null;
  private supabaseUrl: string | null = null;
  private supabaseKey: string | null = null;
  private accessToken: string | null = null;

  /**
   * Configure the sync engine with Supabase credentials
   */
  configure(config: {
    organizationId: string;
    supabaseUrl: string;
    supabaseKey: string;
    accessToken?: string;
  }): void {
    this.organizationId = config.organizationId;
    this.supabaseUrl = config.supabaseUrl;
    this.supabaseKey = config.supabaseKey;
    this.accessToken = config.accessToken || null;
  }

  /**
   * Set the access token for authenticated requests
   */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Perform a full sync (pull then push)
   */
  async fullSync(): Promise<SyncResult> {
    if (this.isSyncing) {
      return {
        success: false,
        recordsPulled: 0,
        recordsPushed: 0,
        conflicts: [],
        errors: [{ table: '', recordId: '', error: 'Sync already in progress', timestamp: new Date().toISOString() }],
        duration: 0,
      };
    }

    const startTime = Date.now();
    this.isSyncing = true;

    const result: SyncResult = {
      success: true,
      recordsPulled: 0,
      recordsPushed: 0,
      conflicts: [],
      errors: [],
      duration: 0,
    };

    try {
      // Pull reference data from server
      for (const table of SYNC_TABLES.filter(t => t.direction === 'down' || t.direction === 'both')) {
        const pullResult = await this.pullTable(table);
        result.recordsPulled += pullResult.recordsProcessed;
        result.errors.push(...pullResult.errors);
      }

      // Push transaction data to server
      for (const table of SYNC_TABLES.filter(t => t.direction === 'up' || t.direction === 'both')) {
        const pushResult = await this.pushTable(table);
        result.recordsPushed += pushResult.recordsProcessed;
        result.conflicts.push(...pushResult.conflicts);
        result.errors.push(...pushResult.errors);
      }

      // Log sync completion
      await auditLogger.logSync('all', result.recordsPulled + result.recordsPushed, 'up');

    } catch (error) {
      result.success = false;
      result.errors.push({
        table: '',
        recordId: '',
        error: error instanceof Error ? error.message : 'Unknown sync error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.isSyncing = false;
      result.duration = Date.now() - startTime;
    }

    return result;
  }

  /**
   * Pull data from server for a specific table
   */
  private async pullTable(config: SyncTableConfig): Promise<{
    recordsProcessed: number;
    errors: SyncError[];
  }> {
    const errors: SyncError[] = [];
    let recordsProcessed = 0;

    try {
      // Get last sync timestamp
      const db = databaseManager.getDatabase();
      const metaStmt = db.prepare('SELECT last_server_timestamp FROM sync_metadata WHERE table_name = ?');
      const meta = metaStmt.get(config.tableName) as { last_server_timestamp: string } | undefined;
      const lastSync = meta?.last_server_timestamp || '1970-01-01T00:00:00Z';

      // Fetch updated records from Supabase
      const response = await this.supabaseRequest(
        `${config.supabaseTable}?organization_id=eq.${this.organizationId}&${config.timestampField}=gt.${lastSync}&order=${config.timestampField}.asc`,
        'GET'
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch ${config.tableName}: ${response.status}`);
      }

      const records = (await response.json()) as any[];

      if (records.length === 0) {
        return { recordsProcessed: 0, errors: [] };
      }

      // Upsert records into local database
      const transaction = db.transaction(() => {
        for (const record of records) {
          const fields = ['id', 'organization_id', ...config.syncFields, 'synced_at', 'updated_at'];
          const placeholders = fields.map(() => '?').join(', ');
          const updates = fields.slice(1).map(f => `${f} = excluded.${f}`).join(', ');
          
          const values = [
            record.id,
            record.organization_id,
            ...config.syncFields.map(f => {
              const val = record[f];
              // Convert objects to JSON strings
              return typeof val === 'object' ? JSON.stringify(val) : val;
            }),
            new Date().toISOString(),
            record[config.timestampField],
          ];

          const stmt = db.prepare(`
            INSERT INTO ${config.tableName} (${fields.join(', ')})
            VALUES (${placeholders})
            ON CONFLICT(id) DO UPDATE SET ${updates}
          `);
          
          stmt.run(...values);
          recordsProcessed++;
        }

        // Update sync metadata
        const lastRecord = records[records.length - 1];
        const updateMeta = db.prepare(`
          INSERT INTO sync_metadata (table_name, last_synced_at, last_server_timestamp, records_synced, sync_direction)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(table_name) DO UPDATE SET
            last_synced_at = excluded.last_synced_at,
            last_server_timestamp = excluded.last_server_timestamp,
            records_synced = records_synced + excluded.records_synced
        `);
        updateMeta.run(
          config.tableName,
          new Date().toISOString(),
          lastRecord[config.timestampField],
          recordsProcessed,
          'down'
        );
      });

      transaction();

    } catch (error) {
      errors.push({
        table: config.tableName,
        recordId: '',
        error: error instanceof Error ? error.message : 'Pull failed',
        timestamp: new Date().toISOString(),
      });
    }

    return { recordsProcessed, errors };
  }

  /**
   * Push local changes to server for a specific table
   */
  private async pushTable(config: SyncTableConfig): Promise<{
    recordsProcessed: number;
    conflicts: ConflictRecord[];
    errors: SyncError[];
  }> {
    const errors: SyncError[] = [];
    const conflicts: ConflictRecord[] = [];
    let recordsProcessed = 0;

    try {
      const db = databaseManager.getDatabase();

      // Get pending records
      const pendingStmt = db.prepare(`
        SELECT * FROM ${config.tableName} 
        WHERE sync_status = 'pending' OR sync_status = 'failed'
        ORDER BY created_at ASC
        LIMIT 100
      `);
      const pendingRecords = pendingStmt.all() as any[];

      for (const record of pendingRecords) {
        try {
          // Mark as syncing
          db.prepare(`UPDATE ${config.tableName} SET sync_status = 'syncing' WHERE id = ?`).run(record.id);

          // Prepare data for Supabase
          const data: Record<string, unknown> = {
            organization_id: this.organizationId,
          };
          
          for (const field of config.syncFields) {
            if (record[field] !== undefined) {
              data[field] = record[field];
            }
          }

          let response: Response;
          
          if (record.server_id) {
            // Update existing server record
            response = await this.supabaseRequest(
              `${config.supabaseTable}?id=eq.${record.server_id}`,
              'PATCH',
              data
            );
          } else {
            // Insert new record
            response = await this.supabaseRequest(
              config.supabaseTable,
              'POST',
              data
            );
          }

          if (response.ok) {
            const serverRecord = (await response.json()) as any;
            const serverId = Array.isArray(serverRecord) ? serverRecord[0]?.id : serverRecord?.id;

            // Mark as synced
            db.prepare(`
              UPDATE ${config.tableName} 
              SET sync_status = 'synced', 
                  server_id = ?,
                  synced_at = ?,
                  sync_error = NULL
              WHERE id = ?
            `).run(serverId || record.server_id, new Date().toISOString(), record.id);

            recordsProcessed++;
          } else if (response.status === 409) {
            // Conflict detected
            const serverRecord = (await this.fetchServerRecord(config.supabaseTable, record.server_id)) as any;
            
            conflicts.push({
              table: config.tableName,
              recordId: record.id,
              localVersion: record.local_version || 1,
              serverVersion: serverRecord?.version || 1,
              localData: record,
              serverData: serverRecord,
              detectedAt: new Date().toISOString(),
            });

            db.prepare(`UPDATE ${config.tableName} SET sync_status = 'conflict' WHERE id = ?`).run(record.id);
          } else {
            throw new Error(`Server returned ${response.status}`);
          }

        } catch (error) {
          // Mark as failed
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          db.prepare(`
            UPDATE ${config.tableName} 
            SET sync_status = 'failed', sync_error = ?
            WHERE id = ?
          `).run(errorMsg, record.id);

          errors.push({
            table: config.tableName,
            recordId: record.id,
            error: errorMsg,
            timestamp: new Date().toISOString(),
          });
        }
      }

    } catch (error) {
      errors.push({
        table: config.tableName,
        recordId: '',
        error: error instanceof Error ? error.message : 'Push failed',
        timestamp: new Date().toISOString(),
      });
    }

    return { recordsProcessed, conflicts, errors };
  }

  /**
   * Fetch a single record from server
   */
  private async fetchServerRecord(table: string, id: string): Promise<unknown> {
    try {
      const response = await this.supabaseRequest(`${table}?id=eq.${id}`, 'GET');
      if (response.ok) {
        const data = await response.json();
        return Array.isArray(data) ? data[0] : data;
      }
    } catch (error) {
      console.error('Failed to fetch server record:', error);
    }
    return null;
  }

  /**
   * Make a request to Supabase REST API
   */
  private async supabaseRequest(
    path: string,
    method: string,
    body?: unknown
  ): Promise<Response> {
    if (!this.supabaseUrl || !this.supabaseKey) {
      throw new Error('Supabase not configured');
    }

    const headers: Record<string, string> = {
      'apikey': this.supabaseKey,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    return fetch(`${this.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * Get count of pending sync records
   */
  getPendingCount(): number {
    try {
      const db = databaseManager.getDatabase();
      const result = db.prepare(`
        SELECT 
          (SELECT count(*) FROM pos_transactions WHERE sync_status IN ('pending', 'failed')) +
          (SELECT count(*) FROM pos_shifts WHERE sync_status IN ('pending', 'failed')) +
          (SELECT count(*) FROM pos_cash_movements WHERE sync_status IN ('pending', 'failed')) +
          (SELECT count(*) FROM pos_returns WHERE sync_status IN ('pending', 'failed'))
        as count
      `).get() as { count: number };
      return result.count;
    } catch {
      return 0;
    }
  }

  /**
   * Get failed sync records
   */
  getFailedRecords(): Array<{ table: string; id: string; error: string; created_at: string }> {
    const failed: Array<{ table: string; id: string; error: string; created_at: string }> = [];
    
    try {
      const db = databaseManager.getDatabase();
      const tables = ['pos_transactions', 'pos_shifts', 'pos_cash_movements', 'pos_returns'];
      
      for (const table of tables) {
        const records = db.prepare(`
          SELECT id, sync_error as error, created_at FROM ${table} WHERE sync_status = 'failed'
        `).all() as Array<{ id: string; error: string; created_at: string }>;
        
        failed.push(...records.map(r => ({ ...r, table })));
      }
    } catch (error) {
      console.error('Failed to get failed records:', error);
    }
    
    return failed;
  }

  /**
   * Retry failed sync for a specific record
   */
  retryRecord(table: string, id: string): void {
    const db = databaseManager.getDatabase();
    db.prepare(`UPDATE ${table} SET sync_status = 'pending', sync_error = NULL WHERE id = ?`).run(id);
  }

  /**
   * Get conflicts for manual resolution
   */
  getConflicts(): ConflictRecord[] {
    const conflicts: ConflictRecord[] = [];
    
    try {
      const db = databaseManager.getDatabase();
      const tables = ['pos_transactions', 'pos_shifts', 'pos_cash_movements', 'pos_returns'];
      
      for (const table of tables) {
        const records = db.prepare(`
          SELECT * FROM ${table} WHERE sync_status = 'conflict'
        `).all() as any[];
        
        for (const record of records) {
          conflicts.push({
            table,
            recordId: record.id,
            localVersion: record.local_version || 1,
            serverVersion: record.server_version || 1,
            localData: record,
            serverData: null, // Would need to fetch from server
            detectedAt: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      console.error('Failed to get conflicts:', error);
    }
    
    return conflicts;
  }

  /**
   * Resolve a conflict
   */
  resolveConflict(table: string, recordId: string, resolution: 'keep_local' | 'keep_server'): void {
    const db = databaseManager.getDatabase();
    
    if (resolution === 'keep_local') {
      // Bump version and retry sync
      db.prepare(`
        UPDATE ${table} 
        SET sync_status = 'pending', 
            local_version = local_version + 1
        WHERE id = ?
      `).run(recordId);
    } else {
      // Delete local and re-pull from server
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(recordId);
      // Server version will be pulled on next sync
    }
  }

  /**
   * Check if sync is in progress
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }
}

// Singleton instance
export const syncEngine = new SyncEngine();
