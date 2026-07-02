/**
 * Stage D — deterministic POS commit idempotency key.
 *
 * The server already de-duplicates commits by `process_pos_transaction.p_idempotency_key`
 * via the unique index `pos_transactions_idempotency_key_uidx`. The bug this hook fixes
 * is purely client-side: the prior offline hook called `crypto.randomUUID()` on every
 * attempt, so a network-retry or double-tap created a second row instead of colliding
 * on the unique index.
 *
 * Contract:
 *   - One key is generated per (register, shift) the first time the caller asks.
 *   - The same key is returned for every subsequent retry until `clear()` is called.
 *   - The caller MUST call `clear()` only after a successful commit response — that
 *     way a 5xx, network drop, or double-tap all reuse the same key and collapse to
 *     a single transaction server-side.
 *   - The key is persisted in `sessionStorage` so a reload mid-commit still
 *     reuses the same key (defensive — the unique index is the actual guarantee).
 */
import { useCallback } from "react";

const STORAGE_PREFIX = "pos.commit-key.v1";

function storageKey(registerId: string, shiftId: string): string {
  return `${STORAGE_PREFIX}.${registerId}.${shiftId}`;
}

function safeRandomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for non-crypto envs (test runners, ancient browsers).
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface CommitKeyApi {
  /** Get the current key for this (register, shift); generate + persist if missing. */
  get: (registerId: string, shiftId: string) => string;
  /** Drop the key. Call ONLY after the server confirms commit. */
  clear: (registerId: string, shiftId: string) => void;
  /** Inspect without generating — for tests / debug. */
  peek: (registerId: string, shiftId: string) => string | null;
}

export function useCommitKey(): CommitKeyApi {
  const get = useCallback((registerId: string, shiftId: string) => {
    if (typeof window === "undefined") return safeRandomUUID();
    const k = storageKey(registerId, shiftId);
    const existing = window.sessionStorage.getItem(k);
    if (existing) return existing;
    const fresh = safeRandomUUID();
    try {
      window.sessionStorage.setItem(k, fresh);
    } catch {
      // Storage may be disabled (private mode, quota); the unique index still protects us.
    }
    return fresh;
  }, []);

  const clear = useCallback((registerId: string, shiftId: string) => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.removeItem(storageKey(registerId, shiftId));
    } catch {
      // Ignore — non-fatal.
    }
  }, []);

  const peek = useCallback((registerId: string, shiftId: string) => {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(storageKey(registerId, shiftId));
    } catch {
      return null;
    }
  }, []);

  return { get, clear, peek };
}