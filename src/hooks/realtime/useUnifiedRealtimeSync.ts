/**
 * Unified Realtime Sync Hook — FINANCE-CRITICAL TABLES ONLY
 * 
 * Subscribes to tables that affect accounting integrity, dashboard KPIs,
 * and financial reports. Non-finance modules (HR, CRM, Projects) are excluded
 * and should use useLazyRealtimeSync at the page/hook level instead.
 * 
 * Tables subscribed (12):
 *   payments, expenses,
 *   journal_entries, accounts, bank_transactions, bank_accounts,
 *   fiscal_periods, fixed_assets
 * 
 * Includes:
 * - Cross-table cascade invalidation (JE → dashboards, balances, reports)
 * - refetchType: 'active' to avoid refetching unmounted queries
 * - Exponential backoff reconnection
 * - Full-state invalidation on reconnect to catch missed events
 */

import { useEffect, useRef, useCallback, useContext } from "react";
import { useQueryClient, QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { BusinessContext } from "@/contexts/BusinessContext";
import { queryKeys } from "@/lib/queryKeys";
import { connectivityManager } from "@/services/resilience/ConnectivityManager";
type RealtimeChannel = any;
type RealtimePostgresChangesPayload<T> = { new: T; old: T; eventType: string; schema: string; table: string; commit_timestamp: string; errors: any };

type PostgresPayload = RealtimePostgresChangesPayload<{ [key: string]: unknown }>;

type TableHandler = (
  payload: PostgresPayload,
  queryClient: QueryClient,
  orgId: string,
  businessId?: string | null
) => void;

// Default handler: invalidates queries but ONLY refetches actively-mounted ones
const createDefaultHandler = (
  getQueryKeys: (orgId: string, businessId?: string | null) => (readonly unknown[])[]
): TableHandler => {
  return (payload, queryClient, orgId, businessId) => {
    const keys = getQueryKeys(orgId, businessId);
    keys.forEach((key) => {
      queryClient.invalidateQueries({
        queryKey: key as unknown[],
        refetchType: 'active', // Only refetch queries with active observers
      });
    });
  };
};

// Helper: report-related query keys
const getReportKeys = (orgId: string) => [
  queryKeys.reports.financial(orgId),
  queryKeys.reports.generalLedger(orgId),
  queryKeys.reports.trialBalance(orgId),
  queryKeys.reports.aging(orgId),
  queryKeys.reports.cashFlow(orgId),
  queryKeys.reports.budgetVsActual(orgId),
];

// Helper: dashboard keys
const getDashboardKeys = (orgId: string, businessId?: string | null) => [
  queryKeys.dashboard.stats(orgId, businessId),
  queryKeys.dashboard.executive(orgId),
];

// Helper: account balance keys
const getBalanceKeys = (orgId: string, businessId?: string | null) => [
  queryKeys.accountBalances.rpc(orgId, businessId),
];

// ══════════════ FINANCE-CRITICAL TABLE HANDLERS ONLY ══════════════

const TABLE_HANDLERS: Record<string, TableHandler> = {
  // Invoices → AR, aging, financial reports, dashboard
  invoices: createDefaultHandler((orgId, businessId) => [
    queryKeys.invoices.all(orgId),
    queryKeys.invoices.list(orgId, businessId),
    queryKeys.reports.aging(orgId),
    queryKeys.reports.financial(orgId),
    ...getDashboardKeys(orgId, businessId),
  ]),


  // Payments → AR/AP aging, financial reports, dashboard, account balances
  payments: createDefaultHandler((orgId, businessId) => [
    queryKeys.payments.all(orgId),
    queryKeys.payments.list(orgId, businessId),
    queryKeys.reports.aging(orgId),
    queryKeys.reports.financial(orgId),
    ...getDashboardKeys(orgId, businessId),
    ...getBalanceKeys(orgId, businessId),
  ]),


  // Expenses → financial reports, dashboard
  expenses: createDefaultHandler((orgId, businessId) => [
    queryKeys.expenses.all(orgId),
    queryKeys.expenses.list(orgId, businessId),
    queryKeys.reports.financial(orgId),
    ...getDashboardKeys(orgId, businessId),
  ]),

  // Credit notes → aging
  credit_notes: createDefaultHandler((orgId, businessId) => [
    queryKeys.creditNotes.all(orgId),
    queryKeys.creditNotes.list(orgId, businessId),
    queryKeys.reports.aging(orgId),
  ]),

  // ══════════════ Accounting — heaviest cascade ══════════════

  // Journal entries → THE critical cascade. Touches ALL finance views.
  // REFINED: Removed invoice/bill invalidation (JE changes don't alter their data).
  // Uses refetchType: 'active' so unmounted report queries won't refetch.
  journal_entries: createDefaultHandler((orgId, businessId) => [
    queryKeys.journalEntries.all(orgId),
    queryKeys.journalEntries.list(orgId, businessId),
    ...getReportKeys(orgId),
    ...getBalanceKeys(orgId, businessId),
    ...getDashboardKeys(orgId, businessId),
    queryKeys.glIntelligence.all(orgId, businessId),
    ['gl-totals', orgId] as const,
    ['fiscal-period-detail', orgId] as const,
    ['partner-ledger', orgId] as const,
    ['journal-report', orgId] as const,
    ['audit-trail', orgId] as const,
    ['depreciation-report', orgId] as const,
  ]),

  // Accounts (CoA changes)
  accounts: createDefaultHandler((orgId, businessId) => [
    queryKeys.accounts.all(orgId),
    queryKeys.reports.financial(orgId),
    queryKeys.reports.generalLedger(orgId),
    queryKeys.reports.trialBalance(orgId),
    ...getBalanceKeys(orgId, businessId),
  ]),

  // Bank transactions → cash flow, dashboard
  bank_transactions: createDefaultHandler((orgId, businessId) => [
    queryKeys.bankTransactions.all(orgId),
    queryKeys.bankTransactions.list(orgId, businessId),
    queryKeys.reports.cashFlow(orgId),
    ...getDashboardKeys(orgId, businessId),
  ]),

  // Bank accounts (metadata changes)
  bank_accounts: createDefaultHandler((orgId, businessId) => [
    queryKeys.bankAccounts.all(orgId),
    queryKeys.bankAccounts.list(orgId, businessId),
    ['bank-accounts', orgId] as const,
  ]),

  // Fiscal periods
  fiscal_periods: createDefaultHandler((orgId, businessId) => [
    queryKeys.fiscalPeriods.all(orgId, businessId),
    ['fiscal-periods', orgId] as const,
    ['fiscal-period-detail', orgId] as const,
  ]),

  // Fixed assets
  fixed_assets: createDefaultHandler((orgId, businessId) => [
    queryKeys.fixedAssets.all(orgId),
    queryKeys.fixedAssets.list(orgId, businessId),
    ['fixed-assets', orgId] as const,
    ['depreciation-schedules', orgId] as const,
  ]),

  // ══════════════ SALES-CRITICAL TABLES ══════════════

  delivery_notes: createDefaultHandler((orgId, businessId) => [
    queryKeys.deliveryNotes.all(orgId),
    queryKeys.deliveryNotes.list(orgId, businessId),
    ...getDashboardKeys(orgId, businessId),
  ]),

  sales_orders: createDefaultHandler((orgId, businessId) => [
    queryKeys.salesOrders.all(orgId),
    queryKeys.salesOrders.list(orgId, businessId),
    ...getDashboardKeys(orgId, businessId),
  ]),

  estimates: createDefaultHandler((orgId, businessId) => [
    queryKeys.estimates.all(orgId),
    queryKeys.estimates.list(orgId, businessId),
    ...getDashboardKeys(orgId, businessId),
  ]),

  proforma_invoices: createDefaultHandler((orgId, businessId) => [
    queryKeys.proformaInvoices.all(orgId),
    queryKeys.proformaInvoices.list(orgId, businessId),
  ]),

  recurring_invoices: createDefaultHandler((orgId, businessId) => [
    queryKeys.recurringInvoices.all(orgId),
    queryKeys.recurringInvoices.list(orgId, businessId),
  ]),

  sales_returns: createDefaultHandler((orgId, businessId) => [
    queryKeys.salesReturns.all(orgId),
    queryKeys.salesReturns.list(orgId, businessId),
    ...getDashboardKeys(orgId, businessId),
  ]),
};

const SUBSCRIBED_TABLES = Object.keys(TABLE_HANDLERS);

// Reconnection constants
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;

/**
 * Unified realtime sync — finance-critical tables only.
 * 
 * Mount once at the app shell level (via RealtimeSyncProvider).
 * Non-finance modules should use useLazyRealtimeSync instead.
 */
export function useUnifiedRealtimeSync(): void {
  const queryClient = useQueryClient();
  const { currentOrg } = useOrganization();
  const businessCtx = useContext(BusinessContext);
  const currentBusiness = businessCtx?.currentBusiness ?? null;

  const channelRef = useRef<RealtimeChannel | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for "latest values" — read inside stable callbacks so the channel
  // doesn't tear down/recreate on every render when business or org refs
  // change identity. This is what was causing the 50–60× reconnect storm.
  const queryClientRef = useRef(queryClient);
  const orgIdRef = useRef<string | undefined>(currentOrg?.id);
  const businessIdRef = useRef<string | null | undefined>(currentBusiness?.id);

  useEffect(() => { queryClientRef.current = queryClient; }, [queryClient]);
  useEffect(() => { orgIdRef.current = currentOrg?.id; }, [currentOrg?.id]);
  useEffect(() => { businessIdRef.current = currentBusiness?.id; }, [currentBusiness?.id]);

  // Stable handler — never re-identifies, so it never retriggers the effect.
  const handleChange = useCallback((payload: PostgresPayload) => {
    const orgId = orgIdRef.current;
    if (!orgId) return;

    const table = payload.table;
    const handler = TABLE_HANDLERS[table];
    if (!handler) return;

    if (import.meta.env.DEV) {
      console.debug(
        `[UnifiedRealtime] ${table} ${payload.eventType}:`,
        payload.new && 'id' in payload.new ? payload.new.id : 'unknown'
      );
    }

    handler(payload, queryClientRef.current, orgId, businessIdRef.current);
  }, []);

  // Stable invalidator — also reads from refs.
  const invalidateAllFinanceKeys = useCallback(() => {
    const orgId = orgIdRef.current;
    if (!orgId) return;

    if (import.meta.env.DEV) {
      console.debug('[UnifiedRealtime] Invalidating all finance keys after reconnect');
    }

    const prefixes = [
      ['journal-entries'], ['accounts'], ['invoices'],
      ['payments'], ['expenses'], ['bank-transactions'], ['bank-accounts'],
      ['fiscal-periods'], ['fiscal-period-detail'], ['fiscal-period'],
      ['fixed-assets'], ['credit-notes'],
      ['dashboard-stats'], ['executive-stats'], ['gl-totals'], ['gl-intelligence'],
      ['account-balances-rpc'], ['financial-report'], ['general-ledger'],
      ['trial-balance'], ['aging-report'], ['cash-flow-report'], ['budget-vs-actual'],
      ['depreciation-schedules'],
      ['delivery-notes'], ['sales-orders'], ['estimates'],
      ['proforma-invoices'], ['recurring-invoices'], ['sales-returns'],
    ];

    const qc = queryClientRef.current;
    prefixes.forEach((prefix) => {
      qc.invalidateQueries({ queryKey: prefix, refetchType: 'active' });
    });
  }, []);

  // The single effect that owns the channel lifecycle.
  // Depends ONLY on the org id — switching orgs is the only legitimate reason
  // to tear the channel down. Business switches reuse the same channel and
  // simply route events through the latest businessIdRef.
  useEffect(() => {
    const orgId = currentOrg?.id;
    if (!orgId) return;

    let cancelled = false;
    reconnectAttemptRef.current = 0;

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
        console.error(
          `[UnifiedRealtime] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached.`
        );
        return;
      }

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      const delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttemptRef.current),
        RECONNECT_MAX_DELAY
      );
      reconnectAttemptRef.current += 1;

      if (import.meta.env.DEV) {
        console.debug(
          `[UnifiedRealtime] Reconnect attempt ${reconnectAttemptRef.current} in ${delay}ms`
        );
      }

      reconnectTimerRef.current = setTimeout(() => {
        if (!cancelled) openChannel();
      }, delay);
    };

    const openChannel = () => {
      if (cancelled) return;

      // Tear down any prior channel before opening a new one.
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      const channel = supabase.channel(`org-${orgId}-finance`, {
        config: { broadcast: { self: false } },
      });

      SUBSCRIBED_TABLES.forEach((table) => {
        channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table,
            filter: `organization_id=eq.${orgId}`,
          },
          handleChange
        );
      });

      channel.subscribe((status) => {
        if (cancelled) return;

        if (status === 'SUBSCRIBED') {
          connectivityManager.reportRealtimeState('subscribed');
          if (import.meta.env.DEV) {
            console.debug(
              `[UnifiedRealtime] Connected — ${SUBSCRIBED_TABLES.length} finance tables`
            );
          }
          if (reconnectAttemptRef.current > 0) {
            if (import.meta.env.DEV) {
              console.debug(
                `[UnifiedRealtime] Reconnected after ${reconnectAttemptRef.current} attempts — refreshing finance data`
              );
            }
            invalidateAllFinanceKeys();
          }
          reconnectAttemptRef.current = 0;
        } else if (status === 'CLOSED') {
          connectivityManager.reportRealtimeState('closed');
          if (import.meta.env.DEV) {
            console.debug('[UnifiedRealtime] Channel CLOSED — scheduling reconnect');
          }
          scheduleReconnect();
        } else if (status === 'CHANNEL_ERROR') {
          connectivityManager.reportRealtimeState('channel_error');
          if (import.meta.env.DEV) {
            console.debug('[UnifiedRealtime] Channel CHANNEL_ERROR — scheduling reconnect');
          }
          scheduleReconnect();
        } else if (status === 'TIMED_OUT') {
          connectivityManager.reportRealtimeState('timed_out');
          scheduleReconnect();
        }
      });

      channelRef.current = channel;
    };

    openChannel();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (channelRef.current) {
        if (import.meta.env.DEV) {
          console.debug('[UnifiedRealtime] Disconnecting');
        }
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
    // Only re-run when the org actually changes. handleChange and
    // invalidateAllFinanceKeys are stable (empty deps), so omitting them
    // here is intentional and required to stop the reconnect loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id]);
}

export default useUnifiedRealtimeSync;
