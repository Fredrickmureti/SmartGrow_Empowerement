import React from "react";
import { useUnifiedRealtimeSync } from "@/hooks/realtime/useUnifiedRealtimeSync";
import { useProductIdentifiersRealtimeSync } from "@/hooks/useProductIdentifiersRealtimeSync";

/**
 * Provider component that sets up centralized real-time synchronization
 * for FINANCE-CRITICAL entities. Mount this inside your auth/org providers.
 *
 * Architecture:
 * 1. useProductRealtimeSync — products table (+ IndexedDB for Electron)
 * 2. useProductIdentifiersRealtimeSync — Stage 4 POS scanner re-audit:
 *    keeps POS barcode resolution coherent with identifier edits.
 * 3. useUnifiedRealtimeSync — 1 channel, finance-critical tables.
 *
 * Non-finance modules (HR, CRM, Projects, etc.) should use
 * useLazyRealtimeSync at the page/hook level for on-demand subscriptions.
 */
export function RealtimeSyncProvider({ children }: { children: React.ReactNode }) {
  useProductIdentifiersRealtimeSync();
  useUnifiedRealtimeSync();

  return <>{children}</>;
}

