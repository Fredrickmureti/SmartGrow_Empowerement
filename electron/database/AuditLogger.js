"use strict";
/**
 * Audit Logger for Offline Operations
 * Tracks all database changes for compliance and sync verification
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogger = void 0;
const uuid_1 = require("uuid");
const DatabaseManager_1 = require("./DatabaseManager");
class AuditLogger {
    constructor() {
        this.organizationId = null;
        this.userId = null;
        this.userEmail = null;
    }
    /**
     * Set the current session context for audit logging
     */
    setContext(organizationId, userId, userEmail) {
        this.organizationId = organizationId;
        this.userId = userId;
        this.userEmail = userEmail;
    }
    /**
     * Clear the session context
     */
    clearContext() {
        this.organizationId = null;
        this.userId = null;
        this.userEmail = null;
    }
    /**
     * Log a database operation
     */
    async log(action, tableName, recordId, oldData, newData) {
        if (!this.organizationId) {
            console.warn('Audit log context not set, skipping log');
            return;
        }
        try {
            const entry = {
                id: (0, uuid_1.v4)(),
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
            const db = DatabaseManager_1.databaseManager.getDatabase();
            const stmt = db.prepare(`
        INSERT INTO audit_log (
          id, organization_id, action, table_name, record_id,
          old_data, new_data, user_id, user_email, is_synced, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            stmt.run(entry.id, entry.organization_id, entry.action, entry.table_name, entry.record_id, entry.old_data, entry.new_data, entry.user_id, entry.user_email, entry.is_synced ? 1 : 0, entry.created_at);
        }
        catch (error) {
            console.error('Failed to write audit log:', error);
            // Don't throw - audit logging should not break main operations
        }
    }
    /**
     * Log a transaction creation
     */
    async logTransaction(transactionId, transactionData) {
        await this.log('create', 'pos_transactions', transactionId, undefined, transactionData);
    }
    /**
     * Log a transaction void
     */
    async logVoid(transactionId, reason) {
        await this.log('void', 'pos_transactions', transactionId, undefined, { reason });
    }
    /**
     * Log a refund/return
     */
    async logReturn(returnId, returnData) {
        await this.log('create', 'pos_returns', returnId, undefined, returnData);
    }
    /**
     * Log a shift operation
     */
    async logShiftOperation(action, shiftId, shiftData) {
        await this.log(action, 'pos_shifts', shiftId, undefined, shiftData);
    }
    /**
     * Log a cash movement
     */
    async logCashMovement(movementId, movementData) {
        await this.log('create', 'pos_cash_movements', movementId, undefined, movementData);
    }
    /**
     * Log a sync operation
     */
    async logSync(tableName, recordCount, direction) {
        await this.log('sync', tableName, undefined, undefined, { recordCount, direction });
    }
    /**
     * Log user login
     */
    async logLogin(userId, email, isOffline) {
        await this.log('login', 'auth', userId, undefined, { email, isOffline });
    }
    /**
     * Log user logout
     */
    async logLogout(userId) {
        await this.log('logout', 'auth', userId, undefined, undefined);
    }
    /**
     * Log terminal unlock
     */
    async logTerminalUnlock(cashierId, method) {
        await this.log('unlock', 'terminal', cashierId, undefined, { method });
    }
    /**
     * Get unsynced audit logs
     */
    getUnsyncedLogs(limit = 1000) {
        try {
            const db = DatabaseManager_1.databaseManager.getDatabase();
            const stmt = db.prepare(`
        SELECT * FROM audit_log 
        WHERE is_synced = 0 
        ORDER BY created_at ASC 
        LIMIT ?
      `);
            return stmt.all(limit);
        }
        catch (error) {
            console.error('Failed to get unsynced logs:', error);
            return [];
        }
    }
    /**
     * Mark logs as synced
     */
    markAsSynced(ids) {
        if (ids.length === 0)
            return;
        try {
            const db = DatabaseManager_1.databaseManager.getDatabase();
            const placeholders = ids.map(() => '?').join(',');
            const stmt = db.prepare(`
        UPDATE audit_log SET is_synced = 1 WHERE id IN (${placeholders})
      `);
            stmt.run(...ids);
        }
        catch (error) {
            console.error('Failed to mark logs as synced:', error);
        }
    }
    /**
     * Get audit logs for a specific record
     */
    getLogsForRecord(tableName, recordId) {
        try {
            const db = DatabaseManager_1.databaseManager.getDatabase();
            const stmt = db.prepare(`
        SELECT * FROM audit_log 
        WHERE table_name = ? AND record_id = ?
        ORDER BY created_at DESC
      `);
            return stmt.all(tableName, recordId);
        }
        catch (error) {
            console.error('Failed to get logs for record:', error);
            return [];
        }
    }
    /**
     * Get audit logs within a date range
     */
    getLogsByDateRange(startDate, endDate) {
        try {
            const db = DatabaseManager_1.databaseManager.getDatabase();
            const stmt = db.prepare(`
        SELECT * FROM audit_log 
        WHERE created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC
      `);
            return stmt.all(startDate, endDate);
        }
        catch (error) {
            console.error('Failed to get logs by date range:', error);
            return [];
        }
    }
    /**
     * Purge old synced logs (keep for 30 days)
     */
    purgeOldLogs(daysToKeep = 30) {
        try {
            const db = DatabaseManager_1.databaseManager.getDatabase();
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
            const stmt = db.prepare(`
        DELETE FROM audit_log 
        WHERE is_synced = 1 AND created_at < ?
      `);
            const result = stmt.run(cutoffDate.toISOString());
            return result.changes;
        }
        catch (error) {
            console.error('Failed to purge old logs:', error);
            return 0;
        }
    }
    /**
     * Export logs to JSON for manual reconciliation
     */
    exportLogs(startDate, endDate) {
        let logs;
        if (startDate && endDate) {
            logs = this.getLogsByDateRange(startDate, endDate);
        }
        else {
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
exports.auditLogger = new AuditLogger();
//# sourceMappingURL=AuditLogger.js.map