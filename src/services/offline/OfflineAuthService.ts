/**
 * Offline Authentication Service
 * Handles credential caching and offline login verification for Electron desktop app
 */

import type { Session, User } from "@supabase/auth-js";
import { offlineStorage, STORES } from "./OfflineStorageService";

interface CachedCredentials {
  email: string;
  passwordHash: string;
  userId: string;
  lastLoginAt: string;
}

interface CachedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: {
    id: string;
    email: string;
    user_metadata: Record<string, unknown>;
  };
  cachedAt: string;
}

interface CachedUserProfile {
  id: string;
  email: string;
  fullName: string;
  organizationId: string;
  role: string;
  permissions: string[];
}

// Device ID for tracking offline devices
const DEVICE_ID_KEY = "device_id";
const CREDENTIALS_KEY = "credentials";
const SESSION_KEY = "session";
const USER_PROFILE_KEY = "user_profile";

class OfflineAuthService {
  private isElectron = typeof window !== "undefined" && !!window.pos?.isElectron;

  /**
   * Generate or retrieve unique device ID
   */
  async getDeviceId(): Promise<string> {
    let deviceId = await this.getSecureData(DEVICE_ID_KEY);
    
    if (!deviceId) {
      deviceId = `device-${crypto.randomUUID()}`;
      await this.saveSecureData(DEVICE_ID_KEY, deviceId);
    }
    
    return deviceId;
  }

  /**
   * Save data securely (uses Electron safeStorage when available)
   */
  private async saveSecureData(key: string, data: string): Promise<boolean> {
    if (this.isElectron && window.pos?.storage?.secureStorage?.save) {
      const result = await window.pos!.storage.secureStorage.save(key, data);
      return result.success;
    }
    
    // Fallback to localStorage for web (not secure for production)
    try {
      localStorage.setItem(`offline_${key}`, data);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load data securely
   */
  private async getSecureData(key: string): Promise<string | null> {
    if (this.isElectron && window.pos?.storage?.secureStorage?.load) {
      const result = await window.pos!.storage.secureStorage.load(key);
      return result.success ? result.data ?? null : null;
    }
    
    // Fallback to localStorage for web
    return localStorage.getItem(`offline_${key}`);
  }

  /**
   * Delete secure data
   */
  private async deleteSecureData(key: string): Promise<boolean> {
    if (this.isElectron && window.pos?.storage?.secureStorage?.delete) {
      const result = await window.pos!.storage.secureStorage.delete(key);
      return result.success;
    }
    
    localStorage.removeItem(`offline_${key}`);
    return true;
  }

  /**
   * Hash password for secure local storage comparison
   */
  private async hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Cache credentials after successful online login
   */
  async cacheCredentials(
    email: string,
    password: string,
    userId: string
  ): Promise<boolean> {
    try {
      const passwordHash = await this.hashPassword(password);
      
      const credentials: CachedCredentials = {
        email: email.toLowerCase(),
        passwordHash,
        userId,
        lastLoginAt: new Date().toISOString(),
      };
      
      return await this.saveSecureData(
        CREDENTIALS_KEY,
        JSON.stringify(credentials)
      );
    } catch (error) {
      console.error("Failed to cache credentials:", error);
      return false;
    }
  }

  /**
   * Verify credentials offline
   */
  async verifyOfflineCredentials(
    email: string,
    password: string
  ): Promise<{ valid: boolean; userId?: string }> {
    try {
      const credentialsJson = await this.getSecureData(CREDENTIALS_KEY);
      
      if (!credentialsJson) {
        return { valid: false };
      }
      
      const credentials: CachedCredentials = JSON.parse(credentialsJson);
      
      if (credentials.email !== email.toLowerCase()) {
        return { valid: false };
      }
      
      const passwordHash = await this.hashPassword(password);
      
      if (credentials.passwordHash !== passwordHash) {
        return { valid: false };
      }
      
      return { valid: true, userId: credentials.userId };
    } catch (error) {
      console.error("Failed to verify offline credentials:", error);
      return { valid: false };
    }
  }

  /**
   * Check if credentials are cached
   */
  async hasCredentialsCached(): Promise<boolean> {
    const credentials = await this.getSecureData(CREDENTIALS_KEY);
    return !!credentials;
  }

  /**
   * Get cached email for display
   */
  async getCachedEmail(): Promise<string | null> {
    try {
      const credentialsJson = await this.getSecureData(CREDENTIALS_KEY);
      
      if (!credentialsJson) {
        return null;
      }
      
      const credentials: CachedCredentials = JSON.parse(credentialsJson);
      return credentials.email;
    } catch {
      return null;
    }
  }

  /**
   * Cache session after successful online login
   */
  async cacheSession(session: Session): Promise<boolean> {
    try {
      const cachedSession: CachedSession = {
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt: session.expires_at || 0,
        user: {
          id: session.user.id,
          email: session.user.email || "",
          user_metadata: session.user.user_metadata || {},
        },
        cachedAt: new Date().toISOString(),
      };
      
      return await this.saveSecureData(
        SESSION_KEY,
        JSON.stringify(cachedSession)
      );
    } catch (error) {
      console.error("Failed to cache session:", error);
      return false;
    }
  }

  /**
   * Get cached session
   */
  async getCachedSession(): Promise<CachedSession | null> {
    try {
      const sessionJson = await this.getSecureData(SESSION_KEY);
      
      if (!sessionJson) {
        return null;
      }
      
      return JSON.parse(sessionJson);
    } catch {
      return null;
    }
  }

  /**
   * Check if cached session is still valid (not expired)
   */
  async isSessionValid(): Promise<boolean> {
    const session = await this.getCachedSession();
    
    if (!session) {
      return false;
    }
    
    // Check if session has expired
    const now = Math.floor(Date.now() / 1000);
    return session.expiresAt > now;
  }

  /**
   * Cache user profile for offline use
   */
  async cacheUserProfile(profile: CachedUserProfile): Promise<boolean> {
    try {
      // Store in IndexedDB for offline access
      await offlineStorage.put(STORES.SETTINGS, {
        key: USER_PROFILE_KEY,
        value: profile,
        updatedAt: new Date().toISOString(),
      });
      
      return true;
    } catch (error) {
      console.error("Failed to cache user profile:", error);
      return false;
    }
  }

  /**
   * Get cached user profile
   */
  async getCachedUserProfile(): Promise<CachedUserProfile | null> {
    try {
      const data = await offlineStorage.get<{ key: string; value: CachedUserProfile }>(
        STORES.SETTINGS,
        USER_PROFILE_KEY
      );
      
      return data?.value || null;
    } catch {
      return null;
    }
  }

  /**
   * Create a mock user object for offline mode
   */
  async createOfflineUser(): Promise<User | null> {
    const session = await this.getCachedSession();
    
    if (!session) {
      return null;
    }
    
    return {
      id: session.user.id,
      email: session.user.email,
      user_metadata: session.user.user_metadata,
      app_metadata: {},
      aud: "authenticated",
      created_at: "",
      role: "authenticated",
    } as User;
  }

  /**
   * Clear all cached auth data
   */
  async clearAll(): Promise<void> {
    await this.deleteSecureData(CREDENTIALS_KEY);
    await this.deleteSecureData(SESSION_KEY);
    await offlineStorage.delete(STORES.SETTINGS, USER_PROFILE_KEY);
    
    if (this.isElectron && window.pos?.storage?.secureStorage?.clearAll) {
      await window.pos!.storage.secureStorage.clearAll();
    }
  }

  /**
   * Check if we're running in Electron
   */
  isElectronApp(): boolean {
    return this.isElectron;
  }

  /**
   * Check if offline login is available
   */
  async isOfflineLoginAvailable(): Promise<boolean> {
    if (!this.isElectron) {
      return false;
    }
    
    const hasCredentials = await this.hasCredentialsCached();
    const hasSession = await this.getCachedSession();
    
    return hasCredentials && !!hasSession;
  }
}

// Singleton instance
export const offlineAuthService = new OfflineAuthService();
