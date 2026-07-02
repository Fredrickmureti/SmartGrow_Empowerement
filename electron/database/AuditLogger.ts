/**
 * Audit Logger for Offline Operations
 * Tracks all database changes for compliance and sync verification
 */

import { v4 as uuidv4 } from 'uuid';
import { databaseManager } from './DatabaseManager';

export interface AuditEntry {
  id: string;
  organization_id: string;
  action: 'create' | 'update' | 'delete' | 'void' | 'sync' | 'login' | 'logout' | 'unlock';
  table_name: string;
  record_id?: string;
  old_data?: string;
  new_data?: string;
  user_id?: string;
  user_email?: string;
  ip_address?: string;
  user_agent?: string;
  is_synced: boolean;
  created_at: string;
}

class AuditLogger {
  private organizationId: string | null = null;
  private userId: string | null = null;
  private userEmail: string | null = null;

  /**
   * Set the current session context for audit logging
   */
  setContext(organizationId: string, userId: string, userEmail: string): void {
    this.organizationId = organizationId;
    this.userId = userId;
    this.userEmail = userEmail;
  }

  /**
   * Clear the session context
   */
  clearContext(): void {
    this.organizationId = null;
    this.userId = null;
    this.userEmail = null;
  }

  /**
   * Log a database operation
   */
  async log(
    action: AuditEntry['action'],
    tableName: string,
    recordId?: string,
    oldData?: unknown,
    newData?: unknown
  ): Promise<void> {
    if (!this.organizationId) {
      console.warn('Audit log context not set, skipping log');
      return;
    }

    try {
      const entry: AuditEntry = {
        id: uuidv4(),
        organization_id: this.organizationId,
        action,
        table_name: tableName,
        record_id: recordId,
        old_data: oldData ? JSON.stringify(oldData) : undefined,
        new_data: newData ? JSON.stringify(newData) : undefined,
        user_id: this.userId || undefined,
        user_email: this.userEmail || undefined,
        is_synced: false,
        created_at: new Date().toISOString(),
      };

      const db = databaseManager.getDatabase();
      const stmt = db.prepare(`
        INSERT INTO audit_log (
          id, organization_id, action, table_name, record_id,
          old_data, new_data, user_id, user_email, is_synced, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        entry.id,
        entry.organization_id,
        entry.action,
        entry.table_name,
        entry.record_id,
        entry.old_data,
        entry.new_data,
        entry.user_id,
        entry.user_email,
        entry.is_synced ? 1 : 0,
        entry.created_at
      );
    } catch (error) {
      console.error('Failed to write audit log:', error);
      // Don't throw - audit logging should not break main operations
    }
  }

  /**
   * Log a transaction creation
   */
  async logTransaction(transactionId: string, transactionData: unknown): Promise<void> {
    await this.log('create', 'pos_transactions', transactionId, undefined, transactionData);
  }

  /**
   * Log a transaction void
   */
  async logVoid(transactionId: string, reason: string): Promise<void> {
    await this.log('void', 'pos_transactions', transactionId, undefined, { reason });
  }

  /**
   * Log a refund/return
   */
  async logReturn(returnId: string, returnData: unknown): Promise<void> {
    await this.log('create', 'pos_returns', returnId, undefined, returnData);
  }

  /**
   * Log a shift operation
   */
  async logShiftOperation(
    action: 'create' | 'update',
    shiftId: string,
    shiftData: unknown
  ): Promise<void> {
    await this.log(action, 'pos_shifts', shiftId, undefined, shiftData);
  }

  /**
   * Log a cash movement
   */
  async logCashMovement(movementId: string, movementData: unknown): Promise<void> {
    await this.log('create', 'pos_cash_movements', movementId, undefined, movementData);
  }

  /**
   * Log a sync operation
   */
  async logSync(tableName: string, recordCount: number, direction: 'up' | 'down'): Promise<void> {
    await this.log('sync', tableName, undefined, undefined, { recordCount, direction });
  }

  /**
   * Log user login
   */
  async logLogin(userId: string, email: string, isOffline: boolean): Promise<void> {
    await this.log('login', 'auth', userId, undefined, { email, isOffline });
  }

  /**
   * Log user logout
   */
  async logLogout(userId: string): Promise<void> {
    await this.log('logout', 'auth', userId, undefined, undefined);
  }

  /**
   * Log terminal unlock
   */
  async logTerminalUnlock(cashierId: string, method: 'pin' | 'password'): Promise<void> {
    await this.log('unlock', 'terminal', cashierId, undefined, { method });
  }

  /**
   * Get unsynced audit logs
   */
  getUnsyncedLogs(limit = 1000): AuditEntry[] {
    try {
      const db = databaseManager.getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM audit_log 
        WHERE is_synced = 0 
        ORDER BY created_at ASC 
        LIMIT ?
      `);
      
      return stmt.all(limit) as AuditEntry[];
    } catch (error) {
      console.error('Failed to get unsynced logs:', error);
      return [];
    }
  }

  /**
   * Mark logs as synced
   */
  markAsSynced(ids: string[]): void {
    if (ids.length === 0) return;

    try {
      const db = databaseManager.getDatabase();
      const placeholders = ids.map(() => '?').join(',');
      const stmt = db.prepare(`
        UPDATE audit_log SET is_synced = 1 WHERE id IN (${placeholders})
      `);
      
      stmt.run(...ids);
    } catch (error) {
      console.error('Failed to mark logs as synced:', error);
    }
  }

  /**
   * Get audit logs for a specific record
   */
  getLogsForRecord(tableName: string, recordId: string): AuditEntry[] {
    try {
      const db = databaseManager.getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM audit_log 
        WHERE table_name = ? AND record_id = ?
        ORDER BY created_at DESC
      `);
      
      return stmt.all(tableName, recordId) as AuditEntry[];
    } catch (error) {
      console.error('Failed to get logs for record:', error);
      return [];
    }
  }

  /**
   * Get audit logs within a date range
   */
  getLogsByDateRange(startDate: string, endDate: string): AuditEntry[] {
    try {
      const db = databaseManager.getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM audit_log 
        WHERE created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC
      `);
      
      return stmt.all(startDate, endDate) as AuditEntry[];
    } catch (error) {
      console.error('Failed to get logs by date range:', error);
      return [];
    }
  }

  /**
   * Purge old synced logs (keep for 30 days)
   */
  purgeOldLogs(daysToKeep = 30): number {
    try {
      const db = databaseManager.getDatabase();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      
      const stmt = db.prepare(`
        DELETE FROM audit_log 
        WHERE is_synced = 1 AND created_at < ?
      `);
      
      const result = stmt.run(cutoffDate.toISOString());
      return result.changes;
    } catch (error) {
      console.error('Failed to purge old logs:', error);
      return 0;
    }
  }

  /**
   * Export logs to JSON for manual reconciliation
   */
  exportLogs(startDate?: string, endDate?: string): string {
    let logs: AuditEntry[];
    
    if (startDate && endDate) {
      logs = this.getLogsByDateRange(startDate, endDate);
    } else {
      logs = this.getUnsyncedLogs(10000);
    }

    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      organizationId: this.organizationId,
      logCount: logs.length,
      logs,
    }, null, 2);
  }
}

// Singleton instance
export const auditLogger = new AuditLogger();
