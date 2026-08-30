/**
 * ReadOnlyModeContext — RETIRED gating, kept as a stable seam.
 *
 * Read-only degradation existed to soften expired SaaS subscriptions.
 * Smart Grow Empowerment is a single-institution Microfinance system: the
 * workspace is never "expired", and what a user may change is decided by
 * RBAC and server-side policy, not by billing state.
 *
 * The provider and hooks remain so call sites keep working; they now always
 * report "not read-only, nothing blocked".
 */
import React, { createContext, useContext, useCallback, useMemo } from "react";

interface ReadOnlyModeContextType {
  isReadOnly: boolean;
  isBlocked: boolean;
  daysUntilExpiry: number | null;
  blockMutation: (action?: string) => boolean;
  shouldBlockMutation: () => boolean;
  readOnlyMessage: string | null;
  openUpgrade: () => void;
}

const FULL_ACCESS: ReadOnlyModeContextType = {
  isReadOnly: false,
  isBlocked: false,
  daysUntilExpiry: null,
  blockMutation: () => false,
  shouldBlockMutation: () => false,
  readOnlyMessage: null,
  openUpgrade: () => {},
};

const ReadOnlyModeContext = createContext<ReadOnlyModeContextType>(FULL_ACCESS);

export function ReadOnlyModeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ReadOnlyModeContext.Provider value={FULL_ACCESS}>{children}</ReadOnlyModeContext.Provider>
  );
}

export function useReadOnlyMode() {
  return useContext(ReadOnlyModeContext);
}

/**
 * Kept for source compatibility: mutations are no longer billing-gated, so
 * the wrapper simply forwards the call.
 */
export function withReadOnlyBlock<T extends (...args: unknown[]) => unknown>(
  fn: T,
  _actionDescription?: string,
): (...args: Parameters<T>) => ReturnType<T> {
  return function (...args: Parameters<T>) {
    return fn(...args) as ReturnType<T>;
  };
}

/** Kept for source compatibility: returns the mutation unchanged. */
export function useProtectedMutation<T extends (...args: never[]) => Promise<unknown>>(
  mutationFn: T,
  _actionDescription?: string,
): T {
  return useCallback(((...args: Parameters<T>) => mutationFn(...args)) as T, [mutationFn]);
}

/** Retained export shape for consumers that memoised the context value. */
export function useReadOnlyModeValue() {
  return useMemo(() => FULL_ACCESS, []);
}
