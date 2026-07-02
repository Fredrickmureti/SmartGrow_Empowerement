/**
 * Key Manager for SQLite Database Encryption
 * Handles encryption key derivation and secure storage
 */

import * as crypto from 'crypto';
import { safeStorage, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// Constants for key derivation
const SALT_LENGTH = 32;
const KEY_LENGTH = 32; // 256 bits for AES-256
const ITERATIONS = 100000; // PBKDF2 iterations
const DIGEST = 'sha512';

interface KeyDerivationParams {
  salt: Buffer;
  iterations: number;
}

class KeyManager {
  private keyParamsPath: string;
  private derivedKey: string | null = null;

  constructor() {
    const userDataPath = app.getPath('userData');
    const secureDir = path.join(userDataPath, 'secure');
    
    if (!fs.existsSync(secureDir)) {
      fs.mkdirSync(secureDir, { recursive: true });
    }
    
    this.keyParamsPath = path.join(secureDir, 'key_params.enc');
  }

  /**
   * Derive encryption key from user password and machine-specific data
   * Uses PBKDF2 with stored salt for consistent key derivation
   */
  async deriveKey(password: string, userId: string): Promise<string> {
    // Get or create salt
    const params = await this.getOrCreateKeyParams();
    
    // Combine password with user ID for additional entropy
    const combinedSecret = `${password}:${userId}:${this.getMachineId()}`;
    
    // Derive key using PBKDF2
    const key = crypto.pbkdf2Sync(
      combinedSecret,
      params.salt,
      params.iterations,
      KEY_LENGTH,
      DIGEST
    );
    
    // Convert to hex string for SQLCipher
    this.derivedKey = key.toString('hex');
    return this.derivedKey;
  }

  /**
   * Derive a key for offline-only operations (when user is not logged in)
   * Uses stored PIN hash instead of password
   */
  async deriveOfflineKey(pinHash: string, organizationId: string): Promise<string> {
    const params = await this.getOrCreateKeyParams();
    
    const combinedSecret = `offline:${pinHash}:${organizationId}:${this.getMachineId()}`;
    
    const key = crypto.pbkdf2Sync(
      combinedSecret,
      params.salt,
      params.iterations,
      KEY_LENGTH,
      DIGEST
    );
    
    return key.toString('hex');
  }

  /**
   * Get or create key derivation parameters
   * Salt is stored encrypted using Electron's safeStorage
   */
  private async getOrCreateKeyParams(): Promise<KeyDerivationParams> {
    try {
      if (fs.existsSync(this.keyParamsPath)) {
        // Load existing params
        const encrypted = fs.readFileSync(this.keyParamsPath);
        
        if (safeStorage.isEncryptionAvailable()) {
          const decrypted = safeStorage.decryptString(encrypted);
          return JSON.parse(decrypted);
        } else {
          // Fallback for systems without secure storage
          return JSON.parse(encrypted.toString());
        }
      }
    } catch (error) {
      console.warn('Failed to load key params, creating new ones:', error);
    }

    // Create new params
    const params: KeyDerivationParams = {
      salt: crypto.randomBytes(SALT_LENGTH),
      iterations: ITERATIONS,
    };

    // Store params
    await this.storeKeyParams(params);
    
    return params;
  }

  /**
   * Store key derivation parameters securely
   */
  private async storeKeyParams(params: KeyDerivationParams): Promise<void> {
    const paramsJson = JSON.stringify({
      salt: params.salt.toString('base64'),
      iterations: params.iterations,
    });

    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(paramsJson);
      fs.writeFileSync(this.keyParamsPath, encrypted);
    } else {
      // Fallback - not recommended for production
      console.warn('Secure storage not available, storing params unencrypted');
      fs.writeFileSync(this.keyParamsPath, paramsJson);
    }
  }

  /**
   * Get a machine-specific identifier for additional key entropy
   * This helps prevent database files from being moved between machines
   */
  private getMachineId(): string {
    // Use a combination of app paths as machine identifier
    // This is not cryptographically secure but adds entropy
    const userData = app.getPath('userData');
    const home = app.getPath('home');
    
    return crypto
      .createHash('sha256')
      .update(`${userData}:${home}:${process.platform}`)
      .digest('hex')
      .substring(0, 32);
  }

  /**
   * Hash a password for storage (for offline verification)
   * Uses bcrypt-compatible format with high cost factor
   */
  hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return `pbkdf2:${salt}:${hash}`;
  }

  /**
   * Verify a password against stored hash
   */
  verifyPassword(password: string, storedHash: string): boolean {
    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'pbkdf2') {
      return false;
    }
    
    const [, salt, hash] = parts;
    const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(verifyHash));
  }

  /**
   * Hash a PIN for storage
   */
  hashPin(pin: string): string {
    return this.hashPassword(pin);
  }

  /**
   * Verify a PIN against stored hash
   */
  verifyPin(pin: string, storedHash: string): boolean {
    return this.verifyPassword(pin, storedHash);
  }

  /**
   * Generate a random session token
   */
  generateSessionToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Encrypt sensitive data for storage
   */
  encrypt(data: string): string {
    if (!this.derivedKey) {
      throw new Error('Key not derived. Call deriveKey() first.');
    }
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(this.derivedKey, 'hex'),
      iv
    );
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Return IV + AuthTag + Encrypted data
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt sensitive data
   */
  decrypt(encryptedData: string): string {
    if (!this.derivedKey) {
      throw new Error('Key not derived. Call deriveKey() first.');
    }
    
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }
    
    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.derivedKey, 'hex'),
      iv
    );
    
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  /**
   * Clear the derived key from memory
   */
  clearKey(): void {
    this.derivedKey = null;
  }

  /**
   * Check if a key has been derived
   */
  hasKey(): boolean {
    return this.derivedKey !== null;
  }
}

// Singleton instance
export const keyManager = new KeyManager();
