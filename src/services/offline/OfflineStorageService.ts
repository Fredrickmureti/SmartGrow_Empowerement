/**
 * IndexedDB-based Offline Storage Service for POS System
 * Provides persistent storage for offline operations with sync capabilities
 */

const DB_NAME = "pos_offline_db";
const DB_VERSION = 1;

// Store names
export const STORES = {
  PRODUCTS: "products",
  TRANSACTIONS_QUEUE: "transactions_queue",
  CUSTOMERS: "customers",
  SETTINGS: "settings",
  SYNC_META: "sync_meta",
} as const;

export interface SyncMeta {
  key: string;
  lastSyncedAt: string;
  version: number;
}

export interface QueuedTransaction {
  id: string;
  data: unknown;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  /**
   * Phase 9 — earliest ISO timestamp at which this row may be retried.
   * Set by `TransactionQueue` from an exponential backoff schedule so a
   * transient failure does not hot-loop the server.
   */
  nextAttemptAt?: string;
  error?: string;
  status: "pending" | "syncing" | "failed" | "completed";
}

class OfflineStorageService {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Initialize the IndexedDB database
   */
  async init(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error("Failed to open IndexedDB:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log("IndexedDB initialized successfully");
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Products store - cached from server
        if (!db.objectStoreNames.contains(STORES.PRODUCTS)) {
          const productsStore = db.createObjectStore(STORES.PRODUCTS, { keyPath: "id" });
          productsStore.createIndex("sku", "sku", { unique: false });
          productsStore.createIndex("category", "category", { unique: false });
          productsStore.createIndex("name", "name", { unique: false });
        }

        // Customers store - cached from server
        if (!db.objectStoreNames.contains(STORES.CUSTOMERS)) {
          const customersStore = db.createObjectStore(STORES.CUSTOMERS, { keyPath: "id" });
          customersStore.createIndex("name", "name", { unique: false });
          customersStore.createIndex("phone", "phone", { unique: false });
        }

        // Transaction queue - for offline transactions
        if (!db.objectStoreNames.contains(STORES.TRANSACTIONS_QUEUE)) {
          const queueStore = db.createObjectStore(STORES.TRANSACTIONS_QUEUE, { keyPath: "id" });
          queueStore.createIndex("status", "status", { unique: false });
          queueStore.createIndex("createdAt", "createdAt", { unique: false });
        }

        // Settings store
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: "key" });
        }

        // Sync metadata store
        if (!db.objectStoreNames.contains(STORES.SYNC_META)) {
          db.createObjectStore(STORES.SYNC_META, { keyPath: "key" });
        }
      };
    });

    return this.dbPromise;
  }

  /**
   * Get the database instance
   */
  private async getDB(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.init();
    }
    return this.db!;
  }

  /**
   * Generic get operation
   */
  async get<T>(storeName: string, key: string): Promise<T | undefined> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Generic get all operation
   */
  async getAll<T>(storeName: string): Promise<T[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Generic put operation (insert or update)
   */
  async put<T>(storeName: string, data: T): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.put(data);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Bulk put operation for efficiency
   */
  async putBulk<T>(storeName: string, items: T[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      items.forEach((item) => store.put(item));
    });
  }

  /**
   * Delete operation
   */
  async delete(storeName: string, key: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all data from a store
   */
  async clear(storeName: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get items by index
   */
  async getByIndex<T>(storeName: string, indexName: string, value: IDBValidKey): Promise<T[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(value);

      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Count items in a store
   */
  async count(storeName: string): Promise<number> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get sync metadata
   */
  async getSyncMeta(key: string): Promise<SyncMeta | undefined> {
    return this.get<SyncMeta>(STORES.SYNC_META, key);
  }

  /**
   * Update sync metadata
   */
  async updateSyncMeta(key: string, lastSyncedAt: string): Promise<void> {
    const existing = await this.getSyncMeta(key);
    await this.put<SyncMeta>(STORES.SYNC_META, {
      key,
      lastSyncedAt,
      version: (existing?.version || 0) + 1,
    });
  }
}

// Singleton instance
export const offlineStorage = new OfflineStorageService();
