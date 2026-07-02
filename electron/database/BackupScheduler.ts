/**
 * Backup Scheduler for Automated Database Backups
 * Provides periodic encrypted backups with configurable retention
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { databaseManager } from './DatabaseManager';

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  maxBackups: number;
  backupPath: string;
}

export interface BackupInfo {
  path: string;
  filename: string;
  date: Date;
  size: number;
}

export interface BackupResult {
  success: boolean;
  path?: string;
  error?: string;
  timestamp?: string;
}

class BackupScheduler {
  private interval: NodeJS.Timeout | null = null;
  private config: BackupConfig;
  private isRunning = false;

  constructor() {
    const userDataPath = app.getPath('userData');
    
    this.config = {
      enabled: true,
      intervalHours: 6,
      maxBackups: 7,
      backupPath: path.join(userDataPath, 'backups'),
    };

    // Ensure backup directory exists
    this.ensureBackupDirectory();
  }

  private ensureBackupDirectory(): void {
    if (!fs.existsSync(this.config.backupPath)) {
      fs.mkdirSync(this.config.backupPath, { recursive: true });
    }
  }

  /**
   * Start the backup scheduler
   */
  start(): void {
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
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[BackupScheduler] Stopped');
    }
  }

  /**
   * Run a backup immediately
   */
  async runBackup(): Promise<BackupResult> {
    if (this.isRunning) {
      console.log('[BackupScheduler] Backup already in progress');
      return { success: false, error: 'Backup already in progress' };
    }

    if (!databaseManager.isReady()) {
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
      
      const result = await databaseManager.backup(backupFilePath);
      
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[BackupScheduler] Backup error:', errorMessage);
      return { success: false, error: errorMessage };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Remove old backups exceeding maxBackups limit
   */
  private async cleanupOldBackups(): Promise<void> {
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
        } catch (err) {
          console.error(`[BackupScheduler] Failed to delete backup: ${backup.filename}`, err);
        }
      }
    } catch (error) {
      console.error('[BackupScheduler] Cleanup failed:', error);
    }
  }

  /**
   * List all available backups
   */
  async listBackups(): Promise<BackupInfo[]> {
    try {
      this.ensureBackupDirectory();
      
      const files = fs.readdirSync(this.config.backupPath);
      const backups: BackupInfo[] = [];

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
    } catch (error) {
      console.error('[BackupScheduler] Failed to list backups:', error);
      return [];
    }
  }

  /**
   * Restore from a backup file
   */
  async restoreFromBackup(backupFilePath: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (!fs.existsSync(backupFilePath)) {
        return { success: false, error: 'Backup file not found' };
      }

      const dbPath = databaseManager.getPath();
      
      // Close current database
      databaseManager.close();

      // Create a backup of current database before restore
      const preRestoreBackup = dbPath + '.pre-restore';
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, preRestoreBackup);
      }

      // Copy backup to database location
      fs.copyFileSync(backupFilePath, dbPath);

      console.log(`[BackupScheduler] Database restored from ${backupFilePath}`);
      
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[BackupScheduler] Restore failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): BackupConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<BackupConfig>): void {
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
  getNextBackupTime(): Date | null {
    if (!this.config.enabled || !this.interval) {
      return null;
    }
    const nextTime = new Date();
    nextTime.setHours(nextTime.getHours() + this.config.intervalHours);
    return nextTime;
  }
}

// Singleton instance
export const backupScheduler = new BackupScheduler();
