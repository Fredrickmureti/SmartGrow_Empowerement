/**
 * SQLite-based Offline Authentication Service
 * Handles user authentication when offline using cached credentials
 */

import { supabase } from '@/integrations/supabase/client';
import {
  isElectron,
  isDatabaseReady,
  initializeDatabase,
  executeQuery,
  executeTransaction,
  hashPassword,
  verifyPassword,
  setAuditContext,
} from './SQLiteBridge';

// Simple UUID generator for offline use
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export interface OfflineUser {
  id: string;
  email: string;
  fullName: string;
  organizationId: string;
  role: string;
}

export interface AuthResult {
  success: boolean;
  user?: OfflineUser;
  isOffline: boolean;
  error?: string;
}

class SQLiteAuthService {
  private currentUser: OfflineUser | null = null;
  private isOnline = true;

  /**
   * Attempt to login - tries online first, falls back to offline
   */
  async login(email: string, password: string): Promise<AuthResult> {
    // Check if we're in Electron
    if (!isElectron()) {
      return this.onlineLogin(email, password);
    }

    // Try online first
    if (navigator.onLine) {
      const onlineResult = await this.onlineLogin(email, password);
      
      if (onlineResult.success && onlineResult.user) {
        // Cache credentials for offline use
        await this.cacheCredentials(email, password, onlineResult.user);
        return onlineResult;
      }
      
      // If online login failed due to network, try offline
      if (onlineResult.error?.includes('network') || onlineResult.error?.includes('fetch')) {
        return this.offlineLogin(email, password);
      }
      
      return onlineResult;
    }

    // Offline - use cached credentials
    return this.offlineLogin(email, password);
  }

  /**
   * Online login via Supabase
   */
  private async onlineLogin(email: string, password: string): Promise<AuthResult> {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return { success: false, isOffline: false, error: error.message };
      }

      if (!data.user) {
        return { success: false, isOffline: false, error: 'No user returned' };
      }

      // Get user's organization from user_roles table
      const { data: membership } = await (supabase as any)
        .from('user_roles')
        .select('organization_id, role')
        .eq('user_id', data.user.id)
        .eq('is_active', true)
        .single();

      const user: OfflineUser = {
        id: data.user.id,
        email: data.user.email || email,
        fullName: data.user.user_metadata?.full_name || email,
        organizationId: (membership as any)?.organization_id || '',
        role: (membership as any)?.role || 'member',
      };

      this.currentUser = user;
      this.isOnline = true;

      return { success: true, user, isOffline: false };
    } catch (error) {
      return {
        success: false,
        isOffline: false,
        error: error instanceof Error ? error.message : 'Login failed',
      };
    }
  }

  /**
   * Offline login using cached SQLite credentials
   */
  private async offlineLogin(email: string, password: string): Promise<AuthResult> {
    try {
      // Check if database is ready
      const ready = await isDatabaseReady();
      
      if (!ready) {
        // Try to initialize with the password
        const initResult = await initializeDatabase(password, email);
        if (!initResult.success) {
          return {
            success: false,
            isOffline: true,
            error: 'Offline database not available. Please login online first.',
          };
        }
      }

      // Look up cached session
      const result = await executeQuery<{
        id: string;
        user_id: string;
        email: string;
        password_hash: string;
        organization_id: string;
        user_role: string;
        full_name: string;
        expires_at: string;
      }>(
        'SELECT * FROM offline_sessions WHERE email = ?',
        [email.toLowerCase()]
      );

      if (!result.success || !result.data?.length) {
        return {
          success: false,
          isOffline: true,
          error: 'No offline credentials found. Please login online first.',
        };
      }

      const session = result.data[0];

      // Check if session expired
      if (new Date(session.expires_at) < new Date()) {
        return {
          success: false,
          isOffline: true,
          error: 'Offline session expired. Please login online to refresh.',
        };
      }

      // Verify password
      const passwordValid = await verifyPassword(password, session.password_hash);
      
      if (!passwordValid) {
        return {
          success: false,
          isOffline: true,
          error: 'Invalid password',
        };
      }

      const user: OfflineUser = {
        id: session.user_id,
        email: session.email,
        fullName: session.full_name || session.email,
        organizationId: session.organization_id,
        role: session.user_role || 'member',
      };

      this.currentUser = user;
      this.isOnline = false;

      // Set audit context
      await setAuditContext(user.organizationId, user.id, user.email);

      return { success: true, user, isOffline: true };
    } catch (error) {
      return {
        success: false,
        isOffline: true,
        error: error instanceof Error ? error.message : 'Offline login failed',
      };
    }
  }

  /**
   * Cache credentials for offline use
   */
  private async cacheCredentials(email: string, password: string, user: OfflineUser): Promise<void> {
    try {
      // Check if database is ready, initialize if not
      let ready = await isDatabaseReady();
      
      if (!ready) {
        const initResult = await initializeDatabase(password, user.id);
        if (!initResult.success) {
          console.error('Failed to initialize database for caching');
          return;
        }
        ready = true;
      }

      // Hash password for offline verification
      const passwordHash = await hashPassword(password);
      
      // Set expiration (30 days from now)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      // Upsert session
      await executeTransaction([
        {
          sql: `
            INSERT INTO offline_sessions (
              id, user_id, email, password_hash, organization_id,
              user_role, full_name, expires_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(email) DO UPDATE SET
              user_id = excluded.user_id,
              password_hash = excluded.password_hash,
              organization_id = excluded.organization_id,
              user_role = excluded.user_role,
              full_name = excluded.full_name,
              expires_at = excluded.expires_at,
              updated_at = datetime('now')
          `,
          params: [
            generateUUID(),
            user.id,
            email.toLowerCase(),
            passwordHash,
            user.organizationId,
            user.role,
            user.fullName,
            expiresAt.toISOString(),
          ],
        },
      ]);

      // Set audit context
      await setAuditContext(user.organizationId, user.id, user.email);
      
      console.log('Credentials cached for offline use');
    } catch (error) {
      console.error('Failed to cache credentials:', error);
    }
  }

  /**
   * Logout user
   */
  async logout(): Promise<void> {
    if (this.isOnline) {
      await supabase.auth.signOut();
    }
    this.currentUser = null;
  }

  /**
   * Get current user
   */
  getCurrentUser(): OfflineUser | null {
    return this.currentUser;
  }

  /**
   * Check if currently online
   */
  getIsOnline(): boolean {
    return this.isOnline;
  }

  /**
   * Set online status (called when network status changes)
   */
  setOnlineStatus(isOnline: boolean): void {
    this.isOnline = isOnline;
  }

  /**
   * Refresh session when coming back online
   */
  async refreshSession(): Promise<boolean> {
    if (!this.currentUser) return false;

    try {
      const { data } = await supabase.auth.getSession();
      
      if (data.session) {
        this.isOnline = true;
        return true;
      }
      
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if offline login is available
   */
  async isOfflineLoginAvailable(email: string): Promise<boolean> {
    if (!isElectron()) return false;
    
    const ready = await isDatabaseReady();
    if (!ready) return false;

    const result = await executeQuery<{ id: string; expires_at: string }>(
      'SELECT id, expires_at FROM offline_sessions WHERE email = ?',
      [email.toLowerCase()]
    );

    if (!result.success || !result.data?.length) return false;

    // Check if not expired
    return new Date(result.data[0].expires_at) > new Date();
  }

  /**
   * Clear offline credentials for a user
   */
  async clearOfflineCredentials(email: string): Promise<void> {
    await executeQuery('DELETE FROM offline_sessions WHERE email = ?', [email.toLowerCase()]);
  }
}

// Singleton instance
export const sqliteAuthService = new SQLiteAuthService();
