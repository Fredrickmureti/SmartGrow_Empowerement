/**
 * SessionContext - Unified session data loaded once at login
 *
 * Single-institution model: there are no subscription plans, entitlements,
 * trials or platform administrators. The session answers exactly two
 * questions: which workspace am I in, and what role do I hold there.
 * Everything else is decided by RBAC and enforced server-side.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Phase-3 (Architecture audit): legacy org-identity mirrors REMOVED.
 *
 * `organizations` is the *institution workspace*. It owns role membership
 * and branding.
 *
 * `businesses` is the *legal entity / accounting boundary*. It owns:
 * base_currency, tax_id, legal_name, email/phone/address (used on documents),
 * chart of accounts, journal entries, fiscal year.
 *
 * The previous version of this file mirrored business-identity fields
 * (`base_currency`, `email`, `address`, `tax_id`, `primary_business`, …)
 * onto every `SessionOrganization` for "backwards compatibility". That
 * created two sources of truth, masked stale data, and contradicted the
 * DB-level invariants enforced by `enforce_je_line_company_match` and
 * `lock_business_currency_after_je`. It is now removed.
 *
 * If you need identity for documents, currency, or branding, read it from:
 *   - useBusinesses().currentBusiness     (current company)
 *   - useDocumentBranding(business_id)    (per-document)
 *   - getOrganizationBranding(business_id)(server-side edge functions)
 * ─────────────────────────────────────────────────────────────────────────
 */
import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { safeRpc } from "@/services/resilience/supabaseSafe";
import { connectivityManager } from "@/services/resilience/ConnectivityManager";
import type { NormalizedError } from "@/services/resilience/ErrorNormalizer";

// Types for session data returned by get_user_session_data RPC.
// Identity fields (base_currency, address, tax_id, email, phone, etc.)
// are intentionally absent — they live on `businesses`, not on the workspace.
export type BranchScopeMode = "all" | "assigned" | "own_portfolio";

export interface SessionBranch {
  id: string;
  name: string;
  code: string | null;
  business_id: string | null;
  is_headquarters: boolean;
}

export interface SessionOrganization {
  id: string;
  name: string;
  slug: string;
  is_suspended: boolean;
  suspended_at: string | null;
  suspended_reason: string | null;
  role:
    | "super_admin" | "owner" | "admin" | "internal"
    | "accountant" | "staff" | "cashier" | "viewer" | "portal"
    // Microfinance operational roles (see LENDING_ROLE_PERMISSIONS)
    | "branch_manager" | "loan_officer" | "credit_officer"
    | "collections_officer" | "auditor";

  role_id: string;
  user_type: "internal" | "portal";
  /** Real-time usage counters for limit enforcement */
  usage_counters: {
    users_count: number;
    invoices_this_month: number;
    invoices_count: number;
    businesses_count: number;
    storage_used_mb: number;
  } | null;
  /** Dynamic permission group rules assigned to this user for this org */
  permission_group_rules: Array<{
    module: string;
    can_read: boolean;
    can_create: boolean;
    can_write: boolean;
    can_delete: boolean;
    can_approve: boolean;
    can_post: boolean;
    can_pay: boolean;
    can_export: boolean;
    can_close: boolean;
    can_reverse: boolean;
    can_admin_override: boolean;
  }>;
  /**
   * Branch dimension of authorization (Wave 2).
   * - `all`: every branch in the organization
   * - `assigned`: only branches explicitly assigned to the user
   * - `own_portfolio`: assigned branches, narrowed further to the user's own clients/loans
   */
  branch_scope: BranchScopeMode;
  /** Branches this user may operate in, already filtered by `branch_scope`. */
  allowed_branches: SessionBranch[];
}


export interface SessionData {
  organizations: SessionOrganization[];
  user_id: string;
  /**
   * Server-trusted "last active workspace" for this user (profiles.last_org_id).
   * Preferred over localStorage during first-render hydration so that:
   *  - a user reloading on machine B sees the same workspace as machine A,
   *  - stale localStorage pointing at a deleted/revoked org is ignored
   *    (the RPC nulls it out before returning).
   * localStorage stays as an offline fallback only.
   */
  last_org_id: string | null;
  fetched_at: string;
}

export type SessionRecoveryStatus = "idle" | "waiting_for_network" | "retrying";

export interface SessionRecoveryState {
  status: SessionRecoveryStatus;
  attempt: number;
  /** Normalized last error kind, when known (offline/timeout/server_unavailable/auth_expired/…). */
  lastErrorKind: NormalizedError["kind"] | null;
}

interface SessionContextType {
  // Session state
  sessionData: SessionData | null;
  isLoading: boolean;
  isRefreshing: boolean;
  /**
   * Last fatal error from `get_user_session_data` after the retry budget
   * was exhausted. When non-null AND `sessionData` is also null, route
   * guards should surface `SessionFailureCard` rather than a misleading
   * empty-workspace screen.
   */
  sessionError: Error | null;
  /**
   * Live recovery state for the bootstrap RPC. `SessionFailureCard`
   * reads this to distinguish "waiting for network" from "retrying"
   * from a truly terminal failure, so a transient network blip never
   * looks like a fatal crash.
   */
  sessionRecovery: SessionRecoveryState;
  /**
   * True once we have a coherent answer for "who is this user, and what
   * workspace are they in?". Specifically:
   *   - auth + session RPC have settled (isLoading === false), AND
   *   - either the user has zero orgs (legit empty state), OR currentOrg
   *     resolved to a real entry in sessionData.organizations.
   *
   * Route guards MUST key off `sessionReady` — not `isLoading` — before
   * redirecting to /select-organization. Otherwise the picker URL flashes
   * during the tick between `setSessionData` and the derived `currentOrg`
   * memo committing.
   */
  sessionReady: boolean;

  // Vendor portal flag
  isVendorUser: boolean;

  // Current organization (selected)
  currentOrg: SessionOrganization | null;
  switchOrganization: (orgId: string) => void;


  userRole: SessionOrganization["role"] | null;
  userType: SessionOrganization["user_type"] | null;

  // Actions
  refreshSession: () => Promise<void>;
  createOrganization: (
    name: string,
    slug: string,
    country?: string,
    currency?: string,
    businessType?: string,
    options?: { legalName?: string },
  ) => Promise<SessionOrganization>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function slugifyFallback(value: string) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "organization"
  );
}

function normalizeUsageCounters(source: unknown): SessionOrganization["usage_counters"] {
  const usage = isRecord(source) ? source : {};
  const usersCount = Number(usage.user_count ?? usage.users_count ?? 0);
  const invoicesCount = Number(usage.invoices_count ?? usage.invoices_this_month ?? 0);

  return {
    users_count: Number.isFinite(usersCount) ? usersCount : 0,
    invoices_this_month: Number.isFinite(invoicesCount) ? invoicesCount : 0,
    invoices_count: Number.isFinite(invoicesCount) ? invoicesCount : 0,
    businesses_count: Number(usage.businesses_count ?? 0) || 0,
    storage_used_mb: Number(usage.storage_used_mb ?? 0) || 0,
  };
}

function normalizePermissionGroupRules(source: unknown) {
  return asArray<Record<string, unknown>>(source)
    .map((rule) => ({
      module: String(rule?.module ?? ""),
      can_read: Boolean(rule?.can_read),
      can_create: Boolean(rule?.can_create),
      can_write: Boolean(rule?.can_write),
      can_delete: Boolean(rule?.can_delete),
      // Segregation-of-duties verbs. These are group-only and MUST survive
      // normalization — dropping them silently removed approve/post/pay/export
      // authority from every access group.
      can_approve: Boolean(rule?.can_approve),
      can_post: Boolean(rule?.can_post),
      can_pay: Boolean(rule?.can_pay),
      can_export: Boolean(rule?.can_export),
      can_close: Boolean(rule?.can_close),
      can_reverse: Boolean(rule?.can_reverse),
      can_admin_override: Boolean(rule?.can_admin_override),
    }))
    .filter((rule) => rule.module.length > 0);
}

const BRANCH_SCOPE_MODES: BranchScopeMode[] = ["all", "assigned", "own_portfolio"];

function normalizeBranchScope(source: unknown): BranchScopeMode {
  return BRANCH_SCOPE_MODES.includes(source as BranchScopeMode)
    ? (source as BranchScopeMode)
    : "assigned";
}

function normalizeAllowedBranches(source: unknown): SessionBranch[] {
  return asArray<Record<string, unknown>>(source)
    .map((branch) => ({
      id: String(branch?.id ?? ""),
      name: String(branch?.name ?? ""),
      code: (branch?.code as string | null) ?? null,
      business_id: (branch?.business_id as string | null) ?? null,
      is_headquarters: Boolean(branch?.is_headquarters),
    }))
    .filter((branch) => branch.id.length > 0);
}

function normalizeOrganizationPayload(org: unknown): SessionOrganization | null {
  if (!isRecord(org)) return null;

  const organizationId = String(org.id ?? "");
  if (!organizationId) return null;

  const name = String(org.name ?? "Organization");

  return {
    id: organizationId,
    name,
    slug: typeof org.slug === "string" && (org.slug as string).length > 0 ? (org.slug as string) : slugifyFallback(name),
    is_suspended: Boolean(org.is_suspended ?? false),
    suspended_at: (org.suspended_at as string | null) ?? null,
    suspended_reason: (org.suspended_reason as string | null) ?? null,
    role: ((org.role as SessionOrganization["role"]) ?? "internal"),
    role_id: String(org.role_id ?? `${organizationId}-role`),
    user_type: ((org.user_type as SessionOrganization["user_type"]) ?? "internal"),
    usage_counters: normalizeUsageCounters(org.usage_counters),
    permission_group_rules: normalizePermissionGroupRules(org.permission_group_rules),
    branch_scope: normalizeBranchScope(org.branch_scope),
    allowed_branches: normalizeAllowedBranches(org.allowed_branches),
  };
}


function normalizeSessionPayload(payload: unknown, userId: string): SessionData {
  const safePayload = isRecord(payload) ? payload : {};
  const organizationsSource = asArray(safePayload.organizations);

  const organizations = organizationsSource
    .map((org) => normalizeOrganizationPayload(org))
    .filter((org): org is SessionOrganization => org !== null);

  return {
    organizations,
    user_id: typeof safePayload.user_id === "string" ? (safePayload.user_id as string) : userId,
    last_org_id:
      typeof safePayload.last_org_id === "string" && (safePayload.last_org_id as string).length > 0
        ? (safePayload.last_org_id as string)
        : null,
    fetched_at:
      typeof safePayload.fetched_at === "string"
        ? (safePayload.fetched_at as string)
        : new Date().toISOString(),
  };
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(() => {
    // localStorage can throw in some environments (privacy modes, blocked storage).
    // We always fall back gracefully to selecting the first org from the session payload.
    try {
      return localStorage.getItem("currentOrgId");
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sessionError, setSessionError] = useState<Error | null>(null);
  const [sessionRecovery, setSessionRecovery] = useState<SessionRecoveryState>({
    status: "idle",
    attempt: 0,
    lastErrorKind: null,
  });

  // Track user ID to prevent refetching on token refresh
  const lastUserIdRef = useRef<string | null>(null);
  const hasFetchedRef = useRef(false);
  const postOnboardingRetriedRef = useRef(false);
  // Guards against overlapping bootstrap loops (e.g. user re-focuses tab
  // while a reconnect-triggered retry is already inflight).
  const inflightBootstrapRef = useRef(false);
  // Set when the current bootstrap loop should abort (e.g. user changed).
  const bootstrapEpochRef = useRef(0);

  // Helper: single RPC attempt through the resilience layer so this
  // critical bootstrap path feeds ConnectivityManager and normalizes
  // errors the same way as every other query in the app.
  const attemptFetch = useCallback(
    async (
      userId: string,
    ): Promise<{ session: SessionData | null; error: NormalizedError | null }> => {
      const { data, error } = await safeRpc(
        supabase.rpc("get_user_session_data", { p_user_id: userId }),
        { timeoutMs: 20_000 },
      );
      if (error) return { session: null, error };
      return { session: normalizeSessionPayload(data, userId), error: null };
    },
    [],
  );

  // Wait until the ConnectivityManager reports online, with a hard cap so
  // we never wedge forever on a stale offline flag.
  const waitForOnline = useCallback(async (timeoutMs = 60_000): Promise<void> => {
    if (connectivityManager.getStatus() === "online") return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const unsubscribe = connectivityManager.subscribe((s) => {
        if (s === "online") finish();
      });
      const timer = setTimeout(finish, timeoutMs);
    });
  }, []);

  // Fetch all session data in ONE call, with resilient retry that
  // honors ConnectivityManager and refreshes an expired auth token
  // before giving up.
  //
  // Retry budget: 6 attempts with jittered exponential backoff, capped
  // at ~15s per wait. Only transient kinds (offline/timeout/server_unavailable)
  // consume retries; auth_expired triggers a one-shot token refresh and
  // is not counted; deterministic kinds (permission_denied/validation)
  // fail fast. When retries are exhausted we still set `sessionError`,
  // but we ALSO leave a connectivity subscription armed so the next
  // online transition restarts the bootstrap automatically.
  const fetchSessionData = useCallback(
    async (isBackground = false): Promise<SessionData | null> => {
      if (!user?.id) {
        setSessionData(null);
        setIsLoading(false);
        setIsRefreshing(false);
        setSessionRecovery({ status: "idle", attempt: 0, lastErrorKind: null });
        return null;
      }

      if (inflightBootstrapRef.current) return null;
      inflightBootstrapRef.current = true;
      const epoch = ++bootstrapEpochRef.current;
      const isStillCurrent = () => epoch === bootstrapEpochRef.current;

      if (!isBackground) setIsLoading(true);
      else setIsRefreshing(true);

      const MAX_ATTEMPTS = 6;
      const BACKOFF_MS = [0, 500, 1500, 4000, 8000, 15000];
      const RETRYABLE = new Set<NormalizedError["kind"]>([
        "offline",
        "timeout",
        "server_unavailable",
      ]);

      let session: SessionData | null = null;
      let lastError: NormalizedError | null = null;
      let authRefreshTried = false;

      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (!isStillCurrent()) return null;

          // If we're known offline, park here instead of burning attempts.
          if (connectivityManager.getStatus() === "offline") {
            setSessionRecovery({
              status: "waiting_for_network",
              attempt: attempt + 1,
              lastErrorKind: lastError?.kind ?? "offline",
            });
            await waitForOnline();
            if (!isStillCurrent()) return null;
          }

          const wait = BACKOFF_MS[attempt] ?? 15000;
          if (wait > 0) {
            const jitter = Math.random() * 300;
            setSessionRecovery({
              status: "retrying",
              attempt: attempt + 1,
              lastErrorKind: lastError?.kind ?? null,
            });
            await new Promise((r) => setTimeout(r, wait + jitter));
            if (!isStillCurrent()) return null;
          } else {
            setSessionRecovery({
              status: "retrying",
              attempt: attempt + 1,
              lastErrorKind: null,
            });
          }

          const { session: got, error } = await attemptFetch(user.id);
          if (!isStillCurrent()) return null;

          if (!error) {
            session = got;
            lastError = null;
            break;
          }

          lastError = error;
          console.warn(
            `[SessionContext] get_user_session_data attempt ${attempt + 1} failed (${error.kind}):`,
            error.cause ?? error.message,
          );

          // Expired JWT: try one token refresh, then retry without
          // consuming an additional slot.
          if (error.kind === "auth_expired" && !authRefreshTried) {
            authRefreshTried = true;
            try {
              await supabase.auth.refreshSession();
            } catch (err) {
              console.warn("[SessionContext] refreshSession failed:", err);
            }
            attempt--; // don't count this attempt
            continue;
          }

          // Fail fast on deterministic errors — retrying won't help.
          if (!RETRYABLE.has(error.kind)) break;
        }
      } finally {
        inflightBootstrapRef.current = false;
      }

      if (!session) {
        // Surface the normalized error but keep last-known-good sessionData
        // untouched (SessionContext already never overwrites on failure).
        const surfaced = new Error(lastError?.message ?? "Failed to load session data");
        (surfaced as Error & { kind?: string }).kind = lastError?.kind;
        setSessionError(surfaced);
        setSessionRecovery({
          status: connectivityManager.getStatus() === "offline" ? "waiting_for_network" : "idle",
          attempt: MAX_ATTEMPTS,
          lastErrorKind: lastError?.kind ?? null,
        });
        setIsLoading(false);
        setIsRefreshing(false);
        return null;
      }



      // Post-onboarding race guard: if the user metadata says onboarding
      // is complete but we see zero memberships, the `user_roles` row
      // may not have committed yet under RLS. Retry once after 600ms.
      const onboardingCompleted =
        user.user_metadata?.onboarding_completed === true;
      if (
        session.organizations.length === 0 &&
        onboardingCompleted &&
        !postOnboardingRetriedRef.current
      ) {
        postOnboardingRetriedRef.current = true;
        await new Promise((resolve) => setTimeout(resolve, 600));
        // Park if the network dropped during the 600ms wait — burning
        // this single retry slot on a known-offline attempt would waste
        // the post-onboarding recovery window.
        if (connectivityManager.getStatus() === "offline") {
          await waitForOnline();
        }
        if (!isStillCurrent()) return null;
        const { session: retried, error: retriedErr } = await attemptFetch(user.id);
        if (retriedErr) {
          console.warn("[SessionContext] post-onboarding retry failed:", retriedErr.cause ?? retriedErr.message);
        } else if (retried && retried.organizations.length > 0) {
          session = retried;
        }
      }

      setSessionRecovery({ status: "idle", attempt: 0, lastErrorKind: null });

      setSessionError(null);
      setSessionData(session);

      // Resolve current org with the server-trusted preference first.
      // Order of precedence:
      //   1. server: profiles.last_org_id (round-trips across devices)
      //   2. client: localStorage["currentOrgId"] (offline fallback)
      //   3. first org in the membership list
      if (session.organizations.length > 0) {
        let storedOrgId: string | null = null;
        try {
          storedOrgId = localStorage.getItem("currentOrgId");
        } catch {
          storedOrgId = null;
        }

        const serverPick = session.last_org_id
          ? session.organizations.find((o) => o.id === session.last_org_id)
          : null;
        const storedPick = storedOrgId
          ? session.organizations.find((o) => o.id === storedOrgId)
          : null;
        const nextOrgId =
          serverPick?.id ?? storedPick?.id ?? session.organizations[0].id;
        setCurrentOrgId(nextOrgId);

        try {
          localStorage.setItem("currentOrgId", nextOrgId);
        } catch {
          // Ignore storage errors; app will still work using in-memory state.
        }
      } else {
        setCurrentOrgId(null);
      }

      hasFetchedRef.current = true;
      setIsLoading(false);
      setIsRefreshing(false);
      return session;
    },
    [user?.id, user?.user_metadata?.onboarding_completed, attemptFetch],
  );

  // Effect to fetch session when user changes
  useEffect(() => {
    const userId = user?.id ?? null;

    if (!user) {
      // CRITICAL: do NOT flip isLoading=false while AuthContext is
      // still restoring. That race is what allowed downstream guards
      // to see (isLoading=false, sessionData=null, organizations=[])
      // for a single render and fire `<Navigate to="/select-organization">`
      // before the real user appeared on the next tick.
      setSessionData(null);
      setCurrentOrgId(null);
      setSessionError(null);
      lastUserIdRef.current = null;
      hasFetchedRef.current = false;
      postOnboardingRetriedRef.current = false;
      setIsLoading(authLoading);
      return;
    }

    // Only fetch if user ID changed or we haven't fetched yet
    if (lastUserIdRef.current !== userId || !hasFetchedRef.current) {
      lastUserIdRef.current = userId;
      postOnboardingRetriedRef.current = false;
      fetchSessionData();
    }
  }, [user, authLoading, fetchSessionData]);

  // Visibility change: when the tab regains focus and our last attempt
  // failed, try one more time. Cheap and high-leverage for users who
  // leave the tab open across a brief outage.
  useEffect(() => {
    if (!user) return;
    const handler = () => {
      if (document.visibilityState === "visible" && sessionError) {
        void fetchSessionData(true);
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [user, sessionError, fetchSessionData]);

  // Connectivity recovery: whenever the ConnectivityManager transitions
  // to `online` and we're either stuck in a fatal bootstrap error or
  // currently waiting for the network, kick off another attempt. This
  // is the missing piece that made "workspace couldn't load" terminal.
  useEffect(() => {
    if (!user) return;
    let firstFire = true;
    const unsub = connectivityManager.subscribe((status) => {
      // The manager fires-once with the current state on subscribe; skip
      // that so we only act on real transitions.
      if (firstFire) {
        firstFire = false;
        return;
      }
      if (status !== "online") return;
      if (sessionError || sessionRecovery.status === "waiting_for_network") {
        void fetchSessionData(true);
      }
    });
    return unsub;
  }, [user, sessionError, sessionRecovery.status, fetchSessionData]);



  useEffect(() => {
    if (!currentOrgId || !user) return;

    const channel = supabase
      .channel(`session-org-${currentOrgId}`)
      .on(
        "postgres_changes" as never,
        {
          event: "UPDATE",
          schema: "public",
          table: "organizations",
          filter: `id=eq.${currentOrgId}`,
        },
        (payload: { new: Record<string, unknown>; old: Record<string, unknown> }) => {
          const changed = payload.new;
          const old = payload.old;

        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentOrgId, user, fetchSessionData]);

  // Current organization derived from session data.
  const currentOrg = useMemo(() => {
    if (!sessionData || !currentOrgId) return null;
    return sessionData.organizations.find((o) => o.id === currentOrgId) || null;
  }, [sessionData, currentOrgId]);

  // Switch organization
  const switchOrganization = useCallback(
    (orgId: string) => {
      if (orgId !== currentOrgId) {
        setCurrentOrgId(orgId);
        try {
          localStorage.setItem("currentOrgId", orgId);
        } catch {
          // ignore
        }
        // Persist preference server-side so the next reload (any device)
        // picks the same workspace without the client having to "discover"
        // it. Fire-and-forget — localStorage is the offline fallback and
        // the RPC defends itself against non-member orgs.
        void supabase
          .rpc("set_last_org_id", { p_org_id: orgId })
          .then(({ error }) => {
            if (error) {
              console.warn("[SessionContext] set_last_org_id failed:", error.message);
            }
          });
        // Invalidate queries to refetch with new org context
        queryClient.invalidateQueries();
      }
    },
    [currentOrgId, queryClient],
  );

  // Create organization (Workspace + first Company + HQ Branch in one RPC)
  const createOrganization = useCallback(
    async (
      name: string,
      slug: string,
      country?: string,
      currency?: string,
      businessType?: string,
      options?: { legalName?: string },
    ): Promise<SessionOrganization> => {
      if (!user) throw new Error("Must be logged in");

      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!session) throw new Error("Your session is not active. Please sign out and sign in again.");

      // Use the unified onboarding RPC so additional workspaces are
      // provisioned identically to the first one (CoA, fiscal periods,
      // owner role, employee record, idempotency). The legacy
      // `create_organization_with_owner` path skipped CoA + periods,
      // producing broken second workspaces — see audit Phase 5 / Refactor 3.
      const idempotencyKey = `create-org-${user.id}-${slug}-${Date.now()}`;
      const { data: rpcResult, error: orgError } = await supabase.rpc("complete_onboarding", {
        p_company_name: name,
        p_slug: slug,
        p_country: country || null,
        p_currency: currency || null,
        p_business_type: businessType || null,
        p_legal_name: options?.legalName || null,
        p_selected_app_ids: [],
        p_invitees: [],
        p_founder_first_name: null,
        p_founder_last_name: null,
        p_idempotency_key: idempotencyKey,
      });

      if (orgError) throw orgError;

      const freshSession = await fetchSessionData();
      const newOrgId =
        (rpcResult as { organization_id?: string; id?: string } | null)?.organization_id ??
        (rpcResult as { id?: string } | null)?.id ??
        null;

      if (newOrgId) {
        const byId = freshSession?.organizations.find((o) => o.id === newOrgId);
        if (byId) return byId;
      }

      const bySlug = freshSession?.organizations.find((o) => o.slug === slug);
      if (bySlug) return bySlug;

      throw new Error("Failed to load new organization");
    },
    [user, fetchSessionData],
  );

  // Derive vendor user flag from auth metadata
  const isVendorUser = user?.user_metadata?.is_vendor_portal === true;

  // Coherent readiness: don't claim "ready" while we still expect currentOrg
  // to resolve (sessionData has orgs but the memo hasn't caught up yet).
  const sessionReady = useMemo(() => {
    if (isLoading || authLoading) return false;
    if (!sessionData) return false;
    const orgs = sessionData.organizations ?? [];
    if (orgs.length === 0) return true; // legit empty state
    return currentOrg !== null;
  }, [isLoading, authLoading, sessionData, currentOrg]);

  const value = useMemo<SessionContextType>(
    () => ({
      sessionData,
      isLoading,
      isRefreshing,
      sessionError,
      sessionRecovery,
      sessionReady,
      isVendorUser,
      currentOrg,
      switchOrganization,
      userRole: currentOrg?.role || null,
      userType: currentOrg?.user_type || null,
      refreshSession: async () => {
        postOnboardingRetriedRef.current = false;
        await fetchSessionData(true);
      },
      createOrganization,
    }),
    [
      sessionData,
      isLoading,
      isRefreshing,
      sessionError,
      sessionRecovery,
      sessionReady,
      isVendorUser,
      currentOrg,
      switchOrganization,
      fetchSessionData,


      createOrganization,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (context === undefined) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}

/**
 * Compatibility hook - provides the same interface as the old useOrganization.
 * This allows gradual migration without breaking existing code.
 */
export function useOrganizationCompat() {
  const session = useSession();

  return {
    organizations: session.sessionData?.organizations || [],
    currentOrg: session.currentOrg,
    userRole: session.currentOrg
      ? {
          id: session.currentOrg.role_id,
          role: session.currentOrg.role,
          organization_id: session.currentOrg.id,
        }
      : null,
    isLoading: session.isLoading,
    switchOrganization: session.switchOrganization,
    createOrganization: session.createOrganization,
    refreshOrganizations: session.refreshSession,
  };
}

