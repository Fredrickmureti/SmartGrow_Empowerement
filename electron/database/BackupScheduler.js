"use strict";
/**
 * Backup Scheduler for Automated Database Backups
 * Provides periodic encrypted backups with configurable retention
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.backupScheduler = void 0;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const DatabaseManager_1 = require("./DatabaseManager");
class BackupScheduler {
    constructor() {
        this.interval = null;
        this.isRunning = false;
        const userDataPath = electron_1.app.getPath('userData');
        this.config = {
            enabled: true,
            intervalHours: 6,
            maxBackups: 7,
            backupPath: path.join(userDataPath, 'backups'),
        };
        // Ensure backup directory exists
        this.ensureBackupDirectory();
    }
    ensureBackupDirectory() {
        if (!fs.existsSync(this.config.backupPath)) {
            fs.mkdirSync(this.config.backupPath, { recursive: true });
        }
    }
    /**
     * Start the backup scheduler
     */
    start() {
        if (!this.config.enabled || this.interval) {
            return;
        }
        console.log(`[BackupScheduler] Starting with ${this.config.intervalHours}h interval`);
        // Run initial backup after 5 minutes
        setTimeout(() => {
            this.runBackup();
        }, 5 * 60 * 1000);
        // Schedule periodic backups
        const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
        this.interval = setInterval(() => {
            this.runBackup();
        }, intervalMs);
    }
    /**
     * Stop the backup scheduler
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            console.log('[BackupScheduler] Stopped');
        }
    }
    /**
     * Run a backup immediately
     */
    async runBackup() {
        if (this.isRunning) {
            console.log('[BackupScheduler] Backup already in progress');
            return { success: false, error: 'Backup already in progress' };
        }
        if (!DatabaseManager_1.databaseManager.isReady()) {
            console.log('[BackupScheduler] Database not ready, skipping backup');
            return { success: false, error: 'Database not ready' };
        }
        this.isRunning = true;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `pos-backup-${timestamp}.db`;
        const backupFilePath = path.join(this.config.backupPath, filename);
        console.log(`[BackupScheduler] Starting backup to ${filename}`);
        try {
            this.ensureBackupDirectory();
            const result = await DatabaseManager_1.databaseManager.backup(backupFilePath);
            if (!result.success) {
                console.error('[BackupScheduler] Backup failed:', result.error);
                return { success: false, error: result.error };
            }
            console.log(`[BackupScheduler] Backup completed: ${filename}`);
            // Cleanup old backups
            await this.cleanupOldBackups();
            return {
                success: true,
                path: backupFilePath,
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error('[BackupScheduler] Backup error:', errorMessage);
            return { success: false, error: errorMessage };
        }
        finally {
            this.isRunning = false;
        }
    }
    /**
     * Remove old backups exceeding maxBackups limit
     */
    async cleanupOldBackups() {
        try {
            const backups = await this.listBackups();
            if (backups.length <= this.config.maxBackups) {
                return;
            }
            // Sort by date, oldest first
            backups.sort((a, b) => a.date.getTime() - b.date.getTime());
            const toDelete = backups.slice(0, backups.length - this.config.maxBackups);
            for (const backup of toDelete) {
                try {
                    fs.unlinkSync(backup.path);
                    console.log(`[BackupScheduler] Deleted old backup: ${backup.filename}`);
                }
                catch (err) {
                    console.error(`[BackupScheduler] Failed to delete backup: ${backup.filename}`, err);
                }
            }
        }
        catch (error) {
            console.error('[BackupScheduler] Cleanup failed:', error);
        }
    }
    /**
     * List all available backups
     */
    async listBackups() {
        try {
            this.ensureBackupDirectory();
            const files = fs.readdirSync(this.config.backupPath);
            const backups = [];
            for (const file of files) {
                if (!file.startsWith('pos-backup-') || !file.endsWith('.db')) {
                    continue;
                }
                const filePath = path.join(this.config.backupPath, file);
                const stats = fs.statSync(filePath);
                backups.push({
                    path: filePath,
                    filename: file,
                    date: stats.mtime,
                    size: stats.size,
                });
            }
            // Sort by date, newest first
            backups.sort((a, b) => b.date.getTime() - a.date.getTime());
            return backups;
        }
        catch (error) {
            console.error('[BackupScheduler] Failed to list backups:', error);
            return [];
        }
    }
    /**
     * Restore from a backup file
     */
    async restoreFromBackup(backupFilePath) {
        try {
            if (!fs.existsSync(backupFilePath)) {
                return { success: false, error: 'Backup file not found' };
            }
            const dbPath = DatabaseManager_1.databaseManager.getPath();
            // Close current database
            DatabaseManager_1.databaseManager.close();
            // Create a backup of current database before restore
            const preRestoreBackup = dbPath + '.pre-restore';
            if (fs.existsSync(dbPath)) {
                fs.copyFileSync(dbPath, preRestoreBackup);
            }
            // Copy backup to database location
            fs.copyFileSync(backupFilePath, dbPath);
            console.log(`[BackupScheduler] Database restored from ${backupFilePath}`);
            return { success: true };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error('[BackupScheduler] Restore failed:', errorMessage);
            return { success: false, error: errorMessage };
        }
    }
    /**
     * Get current configuration
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * Update configuration
     */
    setConfig(config) {
        const wasEnabled = this.config.enabled;
        const oldInterval = this.config.intervalHours;
        this.config = { ...this.config, ...config };
        // Restart scheduler if interval or enabled state changed
        if (config.enabled !== undefined || config.intervalHours !== undefined) {
            if (this.interval) {
                this.stop();
            }
            if (this.config.enabled) {
                this.start();
            }
        }
        // Ensure directory exists if path changed
        if (config.backupPath) {
            this.ensureBackupDirectory();
        }
        console.log('[BackupScheduler] Config updated:', this.config);
    }
    /**
     * Get next scheduled backup time
     */
    getNextBackupTime() {
        if (!this.config.enabled || !this.interval) {
            return null;
        }
        const nextTime = new Date();
        nextTime.setHours(nextTime.getHours() + this.config.intervalHours);
        return nextTime;
    }
}
// Singleton instance
exports.backupScheduler = new BackupScheduler();
//# sourceMappingURL=BackupScheduler.js.map