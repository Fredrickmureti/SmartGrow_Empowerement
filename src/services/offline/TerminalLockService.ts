/**
 * Terminal Lock Service
 * Provides PIN-based terminal locking for POS security
 */

import {
  isElectron,
  isDatabaseReady,
  executeQuery,
  verifyPin,
  logAuditEntry,
} from './SQLiteBridge';

export interface CashierInfo {
  id: string;
  displayName: string;
  employeeNumber: string;
  permissions: string[];
}

export interface UnlockResult {
  success: boolean;
  cashier?: CashierInfo;
  error?: string;
  /**
   * Structured reason so callers can route into ErrorNormalizer
   * without parsing strings. Always set when `success === false`.
   */
  reason?:
    | "not-electron"
    | "db-not-ready"
    | "no-cashiers"
    | "invalid-pin"
    | "no-manager-permissions"
    | "manager-not-found"
    | "unknown";
}

class TerminalLockService {
  private isLocked = false;
  private currentCashier: CashierInfo | null = null;
  private lockTimeout: ReturnType<typeof setTimeout> | null = null;
  private autoLockMinutes = 5; // Default auto-lock timeout

  /**
   * Lock the terminal
   */
  lock(): void {
    this.isLocked = true;
    this.currentCashier = null;
    
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
      this.lockTimeout = null;
    }
  }

  /**
   * Unlock terminal with PIN
   */
  async unlockWithPin(pin: string, organizationId: string): Promise<UnlockResult> {
    if (!isElectron()) {
      return {
        success: false,
        reason: "not-electron",
        error: "Offline PIN unlock is unavailable in this build. Reconnect to the internet and try again.",
      };
    }

    const ready = await isDatabaseReady();
    if (!ready) {
      return {
        success: false,
        reason: "db-not-ready",
        error: "Local POS data is still initialising. Wait a moment and try again.",
      };
    }

    try {
      // Get all active cashiers for this organization
      const result = await executeQuery<{
        id: string;
        display_name: string;
        employee_number: string;
        pin_hash: string;
        permissions: string;
      }>(
        `SELECT id, display_name, employee_number, pin_hash, permissions 
         FROM pos_cashiers 
         WHERE organization_id = ? AND is_active = 1 AND pin_hash IS NOT NULL`,
        [organizationId]
      );

      if (!result.success || !result.data?.length) {
        return { success: false, reason: "no-cashiers", error: "No cashiers are configured on this terminal." };
      }

      // Try to match PIN against each cashier
      for (const cashier of result.data) {
        if (!cashier.pin_hash) continue;

        const isValid = await verifyPin(pin, cashier.pin_hash);
        
        if (isValid) {
          const permissions = cashier.permissions 
            ? JSON.parse(cashier.permissions) 
            : [];

          this.currentCashier = {
            id: cashier.id,
            displayName: cashier.display_name,
            employeeNumber: cashier.employee_number || '',
            permissions,
          };
          
          this.isLocked = false;
          this.startAutoLockTimer();

          // Log the unlock
          await logAuditEntry('unlock', 'terminal', cashier.id, null, { method: 'pin' });

          return { 
            success: true, 
            cashier: this.currentCashier,
          };
        }
      }

      return { success: false, reason: "invalid-pin", error: "Invalid PIN." };
    } catch (error) {
      return {
        success: false,
        reason: "unknown",
        error: error instanceof Error ? error.message : "Unlock failed",
      };
    }
  }

  /**
   * Unlock terminal with manager override
   */
  async unlockWithManagerOverride(
    managerId: string,
    managerPin: string,
    organizationId: string,
    reason: string
  ): Promise<UnlockResult> {
    if (!isElectron()) {
      return {
        success: false,
        reason: "not-electron",
        error: "Offline manager unlock is unavailable in this build. Reconnect and try again.",
      };
    }

    try {
      // Get manager cashier
      const result = await executeQuery<{
        id: string;
        display_name: string;
        employee_number: string;
        pin_hash: string;
        permissions: string;
      }>(
        `SELECT id, display_name, employee_number, pin_hash, permissions 
         FROM pos_cashiers 
         WHERE id = ? AND organization_id = ? AND is_active = 1`,
        [managerId, organizationId]
      );

      if (!result.success || !result.data?.length) {
        return { success: false, error: 'Manager not found' };
      }

      const manager = result.data[0];
      
      // Check if user has manager permissions
      const permissions = manager.permissions ? JSON.parse(manager.permissions) : [];
      if (!permissions.includes('manager_override') && !permissions.includes('admin')) {
        return { success: false, error: 'User does not have manager privileges' };
      }

      // Verify PIN
      if (!manager.pin_hash) {
        return { success: false, error: 'Manager PIN not configured' };
      }

      const isValid = await verifyPin(managerPin, manager.pin_hash);
      if (!isValid) {
        return { success: false, error: 'Invalid manager PIN' };
      }

      this.currentCashier = {
        id: manager.id,
        displayName: manager.display_name,
        employeeNumber: manager.employee_number || '',
        permissions,
      };
      
      this.isLocked = false;
      this.startAutoLockTimer();

      // Log the override
      await logAuditEntry('unlock', 'terminal', manager.id, null, { 
        method: 'manager_override',
        reason,
      });

      return { 
        success: true, 
        cashier: this.currentCashier,
      };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Override failed',
      };
    }
  }

  /**
   * Start auto-lock timer
   */
  private startAutoLockTimer(): void {
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
    }

    this.lockTimeout = setTimeout(() => {
      this.lock();
    }, this.autoLockMinutes * 60 * 1000);
  }

  /**
   * Reset auto-lock timer (call on user activity)
   */
  resetAutoLockTimer(): void {
    if (!this.isLocked && this.autoLockMinutes > 0) {
      this.startAutoLockTimer();
    }
  }

  /**
   * Set auto-lock timeout
   */
  setAutoLockTimeout(minutes: number): void {
    this.autoLockMinutes = minutes;
    if (!this.isLocked && minutes > 0) {
      this.startAutoLockTimer();
    } else if (minutes === 0 && this.lockTimeout) {
      clearTimeout(this.lockTimeout);
      this.lockTimeout = null;
    }
  }

  /**
   * Check if terminal is locked
   */
  getIsLocked(): boolean {
    return this.isLocked;
  }

  /**
   * Get current cashier
   */
  getCurrentCashier(): CashierInfo | null {
    return this.currentCashier;
  }

  /**
   * Check if current cashier has a permission
   */
  hasPermission(permission: string): boolean {
    if (!this.currentCashier) return false;
    return (
      this.currentCashier.permissions.includes(permission) ||
      this.currentCashier.permissions.includes('admin')
    );
  }

  /**
   * Get list of managers for override dialog
   */
  async getManagers(organizationId: string): Promise<Array<{ id: string; name: string }>> {
    if (!isElectron()) return [];

    const ready = await isDatabaseReady();
    if (!ready) return [];

    try {
      const result = await executeQuery<{
        id: string;
        display_name: string;
        permissions: string;
      }>(
        `SELECT id, display_name, permissions 
         FROM pos_cashiers 
         WHERE organization_id = ? AND is_active = 1`,
        [organizationId]
      );

      if (!result.success || !result.data) return [];

      return result.data
        .filter(c => {
          const perms = c.permissions ? JSON.parse(c.permissions) : [];
          return perms.includes('manager_override') || perms.includes('admin');
        })
        .map(c => ({ id: c.id, name: c.display_name }));
    } catch {
      return [];
    }
  }
}

// Singleton instance
export const terminalLockService = new TerminalLockService();
