import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import { usePendingBusinessSetup, PendingBusinessSetup } from "@/hooks/usePendingBusinessSetup";
import { WorkspaceSetupScreen } from "@/components/onboarding/WorkspaceSetupScreen";
import { Loader2 } from "lucide-react";
import { getDefaultSelectedApps } from "@/components/onboarding/AppSelectionStep";
import { SignupRecoveryCard } from "@/components/auth/SignupRecoveryCard";
import { useOnboardingLeader } from "@/hooks/useOnboardingLeader";
import { useWorkspaceReadiness } from "@/hooks/useWorkspaceReadiness";

export default function OnboardingSetup() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isLoading: authLoading } = useAuth();
  // Gate state: 'checking' | 'allowed' | 'redirecting'
  // While 'checking' or 'redirecting', we render a neutral loader and DO NOT
  // mount any of the workspace-provisioning effects below. This is the
  // pattern Stripe / Linear / Notion use: the route owns its own
  // preconditions instead of trusting a global guard. /onboarding-setup is
  // listed as "public" in OnboardingGate so the email-confirmation hash can
  // land here without an auth bounce — that means THIS component is the
  // only thing standing between a random visitor (or an already-onboarded
  // user) and a destructive RPC replay.
  const [gateState, setGateState] = useState<"checking" | "allowed" | "redirecting">("checking");

  useEffect(() => {
    // Always allow the email-confirmation callback through — the hash
    // contains the tokens we need to establish a session. The handler
    // below (handleEmailConfirmation) will set the session and re-run
    // this effect with `user` populated.
    const hasAuthHash = location.hash && location.hash.includes("access_token");
    if (hasAuthHash) {
      setGateState("allowed");
      return;
    }

    // Wait for auth to finish restoring before deciding anything. Bouncing
    // during `authLoading` is what caused the previous "kicked to /login
    // mid-confirmation" race.
    if (authLoading) {
      setGateState("checking");
      return;
    }

    // No session at all → /login. The corrupted-signup user in this case
    // had a session that was wiped server-side; without one, there is
    // nothing meaningful for this page to do.
    if (!user) {
      setGateState("redirecting");
      navigate("/login", { replace: true });
      return;
    }

    // Session exists but email is not yet confirmed → /verify-email.
    // We must NOT run workspace setup for an unverified user; the RPC
    // would either fail RLS or seed orphaned rows.
    if (!user.email_confirmed_at) {
      setGateState("redirecting");
      navigate("/verify-email", { replace: true, state: { email: user.email } });
      return;
    }

    // Already-onboarded users must never re-enter the wizard. Replaying
    // complete_onboarding for a user who already owns a workspace is what
    // produces the "pos_payment_methods_enabled_requires_account" and
    // slug-collision storms. Send them to their real destination.
    const onboardingCompleted = user.user_metadata?.onboarding_completed === true;
    if (onboardingCompleted) {
      setGateState("redirecting");
      // We can't synchronously know if they still have organizations from
      // here without coupling this guard to useOrganization (which itself
      // depends on auth being ready). /home is the canonical post-login
      // landing page; OnboardingGuard there will route them to
      // /select-organization if their org list is empty (e.g. removed by
      // an admin) instead of dumping them back here.
      navigate("/home", { replace: true });
      return;
    }

    // Authenticated, verified, not yet onboarded → legitimate wizard user.
    setGateState("allowed");
  }, [authLoading, user, location.hash, navigate]);

  // Vendor portal users should never reach onboarding
  useEffect(() => {
    if (!authLoading && user?.user_metadata?.is_vendor_portal === true) {
      console.log("[OnboardingSetup] Vendor user detected, redirecting to /vendor-portal");
      navigate("/vendor-portal", { replace: true });
    }
  }, [authLoading, user, navigate]);

  // Platform admins (SaaS operators) must never be funneled through customer
  // workspace onboarding. If they land here for any reason (stale metadata,
  // legacy redirect, bookmarked link), bounce them to /admin-management.
  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from("platform_admins")
          .select("id")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .maybeSingle();
        if (!cancelled && data) {
          console.log("[OnboardingSetup] Platform admin detected, redirecting to /admin-management");
          navigate("/admin-management", { replace: true });
        }
      } catch {
        // Non-fatal; AdminProtectedRoute still gates the destination.
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, user, navigate]);

  const { organizations, createOrganization, refreshOrganizations, isLoading: orgLoading } = useOrganization();
  // Pass user metadata to enable server-side data access
  const { getPendingSetup, clearPendingSetup } = usePendingBusinessSetup(user?.user_metadata);
  
  const [currentStep, setCurrentStep] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [businessName, setBusinessName] = useState("your workspace");
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionEstablished, setSessionEstablished] = useState(false);
  const [invitationsSent, setInvitationsSent] = useState(0);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const setupAttemptedRef = useRef(false);
  // Stable per-user idempotency key.
  // Priority order:
  //   1) auth.users.user_metadata.signup_attempt_id  (durable across devices, tab close)
  //   2) sessionStorage["onboarding_idem_key"]       (durable across reloads in same tab)
  //   3) crypto.randomUUID()                         (first-time bootstrap)
  // Whichever value we settle on is written back to user_metadata immediately
  // (best-effort) so subsequent devices/tabs see the same key — preventing
  // slug collisions when the saga is replayed cross-device.
  const idempotencyKeyRef = useRef<string>("");
  if (!idempotencyKeyRef.current) {
    const fromMeta = (user?.user_metadata as Record<string, unknown> | undefined)
      ?.signup_attempt_id;
    const fromSession = typeof window !== "undefined"
      ? sessionStorage.getItem("onboarding_idem_key")
      : null;
    const seed =
      (typeof fromMeta === "string" && fromMeta) ||
      fromSession ||
      ((typeof crypto !== "undefined" && "randomUUID" in crypto)
        ? crypto.randomUUID()
        : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    idempotencyKeyRef.current = seed;
    if (typeof window !== "undefined") {
      sessionStorage.setItem("onboarding_idem_key", seed);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Multi-tab leader election.
  //
  // Supabase auth broadcasts SIGNED_IN to every tab. Without this gate,
  // all of them race to invoke complete_onboarding() and the second one
  // collides on slug uniqueness or org membership. Only the leader
  // executes the RPC; followers stay on this screen, observe the session
  // refresh, and then navigate via the readiness probe below.
  // ────────────────────────────────────────────────────────────────────
  const { isLeader, isFollower, announceCompleted, announceFailed } = useOnboardingLeader({
    idempotencyKey: idempotencyKeyRef.current,
    enabled: gateState === "allowed" && !!user,
  });

  // ────────────────────────────────────────────────────────────────────
  // Workspace readiness probe.
  //
  // Activated once the leader has completed (or once a follower observes
  // an org membership). Polls the session and listens to Realtime for the
  // user_roles INSERT so the moment the workspace is queryable we can
  // navigate to /home. Times out after 12s so the user is never stranded
  // on a forever-spinner.
  // ────────────────────────────────────────────────────────────────────
  const [provisioningDone, setProvisioningDone] = useState(false);
  const provisioningDoneAtRef = useRef<number | null>(null);
  const tabCountAtStartRef = useRef<number | null>(null);
  const diagnosticsWrittenRef = useRef(false);
  const readiness = useWorkspaceReadiness({
    enabled: provisioningDone,
    timeoutMs: 12_000,
  });
  // Retry helper: writes auth user_metadata with backoff (1s, 2s, 4s).
  // The post-RPC metadata flip used to fail silently on flaky networks,
  // leaving onboarding_completed=false for users whose workspace was already
  // provisioned. Retrying with backoff matches Xero/Odoo SaaS provisioning.
  const updateUserMetadataWithRetry = async (
    data: Record<string, unknown>,
    attempts = 3,
  ): Promise<void> => {
    let lastErr: unknown = null;
    for (let i = 0; i < attempts; i++) {
      const { error } = await supabase.auth.updateUser({ data });
      if (!error) return;
      lastErr = error;
      console.warn(
        `[OnboardingSetup] updateUser attempt ${i + 1}/${attempts} failed:`,
        error,
      );
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
    }
    throw lastErr;
  };

  const totalSteps = 5; // org, accounts, apps, invitations, dashboard

  // Handle email confirmation hash on mount
  useEffect(() => {
    const handleEmailConfirmation = async () => {
      // Check for hash fragment (email confirmation callback)
      const hash = location.hash;
      console.log("[OnboardingSetup] Checking for hash fragment:", hash ? "present" : "none");
      
      if (hash && hash.includes("access_token")) {
        // Parse the hash to extract tokens
        const params = new URLSearchParams(hash.substring(1));
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");
        const type = params.get("type");

        console.log("[OnboardingSetup] Token type:", type);

        if (accessToken && refreshToken) {
          try {
            // Set the session from the confirmation tokens
            const { error } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });

            if (error) {
              // Stale-link recovery: the token is no longer valid (most
              // commonly because the user self-reaped their orphaned
              // account via "Start over with this email", which deleted
              // the auth.users row this token references). Hand off to
              // /auth/callback which probes signup_cleanup_log and shows
              // the right actionable copy ("sign up again" vs "request
              // a fresh link") instead of dead-ending here.
              console.warn(
                "[OnboardingSetup] setSession failed, delegating to /auth/callback:",
                error.message,
              );
              window.location.replace(`/auth/callback${hash}`);
              return;
            }

            console.log("[OnboardingSetup] Session established from hash");

            // Force refresh to get latest user metadata
            const { data: { user: freshUser } } = await supabase.auth.getUser();
            console.log("[OnboardingSetup] Fresh user metadata:", freshUser?.user_metadata);

            // Clear the hash from URL
            window.history.replaceState(null, "", location.pathname);
            
            // Mark session as established to trigger workspace setup
            setSessionEstablished(true);
          } catch (err) {
            console.error("[OnboardingSetup] Error during email confirmation:", err);
            setError("An error occurred during confirmation. Please try logging in.");
          }
        }
      } else {
        // No hash - user navigated here directly
        // Check if we have an active session
        const { data: { session } } = await supabase.auth.getSession();
        console.log("[OnboardingSetup] No hash, checking session:", session?.user?.id);
        
        if (session?.user) {
          // Check if email is confirmed
          if (session.user.email_confirmed_at) {
            console.log("[OnboardingSetup] Active verified session found (no hash)");
            setSessionEstablished(true);
          } else {
            console.log("[OnboardingSetup] User email not confirmed, redirecting to verify-email");
            navigate("/verify-email", { state: { email: session.user.email } });
          }
        } else {
          // No session at all - give auth context time to load
          console.log("[OnboardingSetup] No session found, waiting for auth context...");
        }
      }
    };

    handleEmailConfirmation();
  }, [location, navigate]);

  // Run workspace setup after auth is ready OR after session is established from hash
  useEffect(() => {
    const setupWorkspace = async () => {
      // Hard gate: never run provisioning until the route guard above has
      // explicitly allowed this user through. Prevents replay-on-revisit
      // for already-onboarded users and stops anonymous visitors from
      // triggering RPCs.
      if (gateState !== "allowed") {
        return;
      }

      // Multi-tab gate: only the leader tab actually runs the saga.
      // Followers stay on this screen and observe; once the leader
      // announces completion (or the workspace becomes visible via
      // session refresh), the readiness probe + navigation effect below
      // will route them to /home.
      if (!isLeader) {
        if (isFollower) {
          console.log("[OnboardingSetup] Follower tab — waiting for leader to provision");
        }
        return;
      }

      // Wait for auth to be ready
      if (authLoading) {
        console.log("[OnboardingSetup] Auth still loading...");
        return;
      }

      // Wait for organizations to finish loading to avoid creating twice
      if (orgLoading) {
        console.log("[OnboardingSetup] Organizations still loading...");
        return;
      }

      // If no user, wait — auth may still be restoring. Do NOT bounce to /login
      // via setTimeout; that races with session restoration after email
      // confirmation and can kick the user out mid-flow. The effect re-runs
      // when `user` becomes truthy.
      if (!user) {
        console.log("[OnboardingSetup] No user yet — waiting for auth to settle");
        return;
      }

      console.log("[OnboardingSetup] User found:", user.id);
      console.log("[OnboardingSetup] User metadata:", user.user_metadata);

      // Prevent double execution
      if (setupAttemptedRef.current || isProcessing) {
        console.log("[OnboardingSetup] Setup already attempted or in progress");
        return;
      }
      
      // If user already has organizations, treat onboarding as complete (prevents flash/loop)
      if (organizations.length > 0) {
        console.log("[OnboardingSetup] Organizations already exist, finalizing onboarding");

        setupAttemptedRef.current = true;
        setIsProcessing(true);
        setCurrentStep(totalSteps - 1);

        // Clear pending setup data and mark onboarding complete (idempotent).
        // Uses retry-with-backoff so a flaky network on the metadata flip
        // doesn't leave the user stuck with onboarding_completed=false.
        clearPendingSetup();
        try {
          await updateUserMetadataWithRetry({
            onboarding_completed: true,
            pending_company_name: null,
            pending_country: null,
            pending_currency: null,
            pending_business_type: null,
            pending_industry: null,
            pending_selected_apps: null,
            pending_team_invitees: null,
          });
        } catch (e) {
          console.error("[OnboardingSetup] Final metadata flip failed after retries:", e);
          setError(
            "Your workspace is ready, but we couldn't update your account flag. Please refresh — if this persists, use Reset signup below.",
          );
          return;
        }

        setIsComplete(true);
        return;
      }

      // Pending setup comes from auth.users.user_metadata (single source of
      // truth). No retry / setTimeout needed — the hook is synchronous over
      // user.user_metadata which is already loaded by the time we get here.
      const pendingSetup = getPendingSetup();
      console.log("[OnboardingSetup] Pending setup:", pendingSetup);

      if (!pendingSetup?.businessName) {
        // INVITED-USER RESUME GUARD.
        // Before showing any "setup error" copy, ask the server whether
        // this signed-in identity has a pending organization invitation.
        // If yes, the user is an invited employee — never a founder — and
        // must be routed to /accept-invitation, not into the founder
        // workspace wizard. Fixes the "We couldn't finish setting up your
        // account" dead-end reported 2026-06-13.
        try {
          const { data: resume } = await supabase.rpc("resume_my_invitation" as any);
          const r = resume as { status?: string; token?: string } | null;
          if (r?.status === "pending" && r.token) {
            navigate(`/accept-invitation?token=${encodeURIComponent(r.token)}`, { replace: true });
            return;
          }
        } catch (e) {
          console.warn("[OnboardingSetup] resume_my_invitation probe failed:", e);
        }

        const metadataSaysComplete = user.user_metadata?.onboarding_completed === true;
        if (organizations.length === 0 && metadataSaysComplete) {
          console.log("[OnboardingSetup] Stale onboarding_completed flag detected — surfacing recovery card");
          setError(
            "Your previous workspace was removed. Use 'Start over with this email' below to reset and try again.",
          );
          return;
        }
        console.log("[OnboardingSetup] No pending setup data found");
        setError("We could not find your signup setup details. Please retry signup or contact support.");
        return;
      }

      setupAttemptedRef.current = true;
      setIsProcessing(true);
      setBusinessName(pendingSetup.businessName);
      console.log("[OnboardingSetup] Starting workspace setup for:", pendingSetup.businessName);

      // Persist the idempotency key to user_metadata so a tab close + reopen
      // (or a different device finishing the saga) replays with the same key.
      // Best-effort; failure is logged but does not block setup.
      const metaKey = (user.user_metadata as Record<string, unknown> | undefined)
        ?.signup_attempt_id;
      if (metaKey !== idempotencyKeyRef.current) {
        try {
          await supabase.auth.updateUser({
            data: { signup_attempt_id: idempotencyKeyRef.current },
          });
        } catch (e) {
          console.warn("[OnboardingSetup] Failed to persist signup_attempt_id:", e);
        }
      }

      // Get selected apps and team invitees from metadata or localStorage
      const selectedApps = getSelectedAppsFromMetadata(user.user_metadata);
      const teamInvitees = getTeamInviteesFromMetadata(user.user_metadata);
      console.log("[OnboardingSetup] Selected apps:", selectedApps);
      console.log("[OnboardingSetup] Team invitees:", teamInvitees);

      try {
        const upsertAttempt = async (status: string, extra: Record<string, unknown> = {}) => {
          const { data, error } = await (supabase.from as any)("onboarding_attempts")
            .upsert({
              user_id: user.id,
              idempotency_key: idempotencyKeyRef.current,
              company_name: pendingSetup.businessName,
              country: pendingSetup.country,
              currency: pendingSetup.currency,
              status,
              error_message: null,
              ...extra,
            }, { onConflict: "user_id,idempotency_key" })
            .select("id")
            .single();
          if (error) console.warn("[OnboardingSetup] Attempt state update failed:", error);
          if (data?.id) setAttemptId(data.id);
        };

        // Step 1: Creating organization (0-based)
        setCurrentStep(0);
        await upsertAttempt("provisioning_org");
        await new Promise(resolve => setTimeout(resolve, 400));

        const slug = pendingSetup.businessName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");

        // Resolve founder name (same logic as before, kept inline for clarity)
        const rawName = user.user_metadata?.full_name || "";
        const nameParts = rawName.trim().split(/\s+/).filter(Boolean);
        const looksLikeEmail = (name: string) => {
          const t = name.trim();
          if (!t) return true;
          if (/^[a-z0-9._-]+$/.test(t) && (!/\s/.test(t))) {
            if (user.email && t.toLowerCase() === user.email.split("@")[0]?.toLowerCase()) return true;
            if (/\d/.test(t)) return true;
          }
          return false;
        };
        let founderFirst = "";
        let founderLast = "";
        if (nameParts.length > 0 && !looksLikeEmail(nameParts[0])) {
          founderFirst = nameParts[0];
          founderLast = nameParts.slice(1).join(" ") || "";
        } else {
          const { data: profileRow } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("user_id", user.id)
            .maybeSingle();
          const profileName = profileRow?.full_name?.trim() || "";
          const profileParts = profileName.split(/\s+/).filter(Boolean);
          if (profileParts.length > 0 && !looksLikeEmail(profileParts[0])) {
            founderFirst = profileParts[0];
            founderLast = profileParts.slice(1).join(" ") || "";
          } else {
            founderFirst = "Admin";
            founderLast = "";
          }
        }

        const selectedApps = getSelectedAppsFromMetadata(user.user_metadata);
        const teamInvitees = getTeamInviteesFromMetadata(user.user_metadata);

        // ATOMIC: org + company + branch + apps + invitations + employee, all in one TX
        const { data: onboardResult, error: onboardError } = await supabase.rpc(
          "complete_onboarding" as any,
          {
            p_company_name: pendingSetup.businessName,
            p_slug: slug,
            p_country: pendingSetup.country,
            p_currency: pendingSetup.currency,
            p_business_type: pendingSetup.businessType || null,
            p_legal_name: pendingSetup.legalName || null,
            p_selected_app_ids: selectedApps,
            p_invitees: teamInvitees.map((i: any) => ({ email: i.email, role: i.role })),
            p_founder_first_name: founderFirst,
            p_founder_last_name: founderLast,
            p_idempotency_key: idempotencyKeyRef.current,
          } as any
        );

        if (onboardError) throw onboardError;
        const result = onboardResult as {
          organization_id: string;
          business_id: string;
          invitation_ids: string[];
          installed_apps?: string[];
          failed_apps?: string[];
          warnings?: string[];
        };
        await upsertAttempt("provisioning_company", { organization_id: result.organization_id, business_id: result.business_id });
        console.log("[OnboardingSetup] Atomic onboarding completed:", result);
        if (result.failed_apps && result.failed_apps.length > 0) {
          console.warn("[OnboardingSetup] Some apps failed to install (non-blocking):", result.failed_apps, result.warnings);
        }

        // Stamp the selected industry on the newly-created business so
        // downstream UI (dashboards, templates, vocabulary packs) can
        // flavor itself to the operator's vertical instead of defaulting
        // to a single industry's look-and-feel. Non-blocking — a failure
        // here just means the user keeps neutral defaults.
        if (pendingSetup.industry) {
          const { error: industryError } = await supabase
            .from("businesses")
            .update({ industry: pendingSetup.industry })
            .eq("id", result.business_id);
          if (industryError) {
            console.warn("[OnboardingSetup] Failed to stamp industry (non-blocking):", industryError);
          }
        }

        // Step 2: Localization pack — REMOVED from auto-install (Odoo alignment).
        // The complete_onboarding RPC already provisions a generic CoA + tax
        // rates, which is fully functional for accounting. Country-specific
        // localization packs (Kenya VAT codes, KRA categories, etc.) are an
        // OPTIONAL overlay the user installs deliberately from
        // Settings → Localization. Auto-installing based on country was the
        // Odoo-deviation flagged by the architecture audit: Odoo asks the
        // user to pick the localization at company creation; it does not
        // silently overlay tax overrides on top of the generic CoA.
        //
        // To install a pack post-signup, see LocalizationPackSettings.tsx.
        setCurrentStep(1);

        // Step 3: Apps already installed by complete_onboarding RPC
        setCurrentStep(2);
        await upsertAttempt("installing_apps", { organization_id: result.organization_id, business_id: result.business_id });
        await new Promise(resolve => setTimeout(resolve, 200));

        // Step 4: Send invitation emails in parallel (non-blocking).
        // Failures are logged but never block the user from reaching the dashboard.
        setCurrentStep(3);
        await upsertAttempt("sending_invites", { organization_id: result.organization_id, business_id: result.business_id });
        const invitationIds: string[] = result.invitation_ids || [];
        const emailResults = await Promise.allSettled(
          invitationIds.map((invitationId) =>
            supabase.functions.invoke("send-invitation-email", { body: { invitationId } })
          )
        );
        const sentCount = emailResults.filter(
          (r) => r.status === "fulfilled" && !(r.value as any)?.error
        ).length;
        setInvitationsSent(sentCount);

        // Step 5: Preparing dashboard
        setCurrentStep(4);
        await upsertAttempt("completed", { organization_id: result.organization_id, business_id: result.business_id, completed_at: new Date().toISOString() });

        // Clear pending setup data and mark onboarding complete with retry-with-backoff.
        clearPendingSetup();
        try {
          await updateUserMetadataWithRetry({
            onboarding_completed: true,
            pending_company_name: null,
            pending_country: null,
            pending_currency: null,
            pending_business_type: null,
            pending_industry: null,
            pending_selected_apps: null,
            pending_team_invitees: null,
          });
        } catch (e) {
          console.error("[OnboardingSetup] Final metadata flip failed after retries:", e);
          setError(
            "Your workspace was created, but we couldn't update your account flag. Please refresh — if this persists, click Retry below.",
          );
          return;
        }
        // Onboarding succeeded — drop the idempotency key so a future
        // workspace creation gets a fresh one.
        if (typeof window !== "undefined") sessionStorage.removeItem("onboarding_idem_key");

        // Notify platform admins via direct RPC (replaces the edge function;
        // fire-and-forget — never block the dashboard).
        void supabase
          .rpc("notify_admins_new_signup", {
            _user_id: user.id,
            _email: user.email || "",
            _full_name: user.user_metadata?.full_name || "",
            _signed_up_at: user.created_at || new Date().toISOString(),
          })
          .then(({ error: notifyErr }) => {
            if (notifyErr) console.warn("[OnboardingSetup] Admin notification failed (non-fatal):", notifyErr);
          });

        await refreshOrganizations();
        setIsComplete(true);
        console.log("[OnboardingSetup] Workspace setup complete!");


      } catch (err: any) {
        console.error("[OnboardingSetup] Workspace setup failed:", err);

        // Detect true replay / slug-collision signals only. Do not collapse
        // unrelated provisioning bugs (for example duplicate HQ branch creation)
        // into a fake “workspace name already exists” message.
        const status = (err && (err.status ?? err.statusCode)) as number | undefined;
        const code = String(err?.code || "");
        const msg = String(err?.message || "").toLowerCase();
        const details = String(err?.details || "").toLowerCase();
        const isExplicitSlugCollision =
          msg.includes("workspace name") ||
          msg.includes("already taken") ||
          msg.includes("organizations_slug_key") ||
          details.includes("organizations_slug_key");
        const isReplayCandidate = status === 409 || isExplicitSlugCollision;
        const isBranchConflict =
          details.includes("idx_branches_one_hq_per_business") ||
          msg.includes("idx_branches_one_hq_per_business") ||
          msg.includes("headquarters branch") ||
          msg.includes("duplicate hq branch");

        if (isReplayCandidate) {
          console.warn("[OnboardingSetup] Treating as idempotent replay; verifying ownership");
          await refreshOrganizations();

          const { data: ownedOrg } = await supabase
            .from("organizations")
            .select("id")
            .eq("owner_user_id", user.id)
            .limit(1)
            .maybeSingle();

          if (!ownedOrg) {
            console.error("[OnboardingSetup] Slug collision without owned workspace");
            setError(
              "A workspace with this name already exists. Please go back and choose a different business name."
            );
            return;
          }

          clearPendingSetup();
          try {
            await updateUserMetadataWithRetry({
              onboarding_completed: true,
              pending_company_name: null,
              pending_country: null,
              pending_currency: null,
              pending_business_type: null,
              pending_industry: null,
              pending_selected_apps: null,
              pending_team_invitees: null,
            });
          } catch (e) {
            console.error("[OnboardingSetup] Replay metadata flip failed after retries:", e);
            setError(
              "Your existing workspace was found, but we couldn't update your account flag. Click Retry below to try again.",
            );
            return;
          }
          if (typeof window !== "undefined") sessionStorage.removeItem("onboarding_idem_key");

          setCurrentStep(totalSteps - 1);
          setIsComplete(true);
          return;
        }

        if (isBranchConflict) {
          setError("Workspace setup hit a duplicate headquarters-branch conflict. Retry setup now that the backend path has been corrected.");
          return;
        }

        const message = err.message || "Failed to set up your workspace. Please try again.";
        setError(message);
        await (supabase.from as any)("onboarding_attempts")
          .upsert({
            user_id: user.id,
            idempotency_key: idempotencyKeyRef.current,
            company_name: pendingSetup.businessName,
            country: pendingSetup.country,
            currency: pendingSetup.currency,
            status: "failed",
            error_message: message,
          }, { onConflict: "user_id,idempotency_key" });
      }
    };

    setupWorkspace();
  }, [
    gateState,
    authLoading,
    orgLoading,
    user,
    organizations.length,
    getPendingSetup,
    createOrganization,
    clearPendingSetup,
    refreshOrganizations,
    navigate,
    isProcessing,
    sessionEstablished, // Re-run when session is established from hash
    isLeader,           // Re-run when this tab is promoted to leader
    isFollower,         // Re-run when this tab becomes follower
  ]);

  // Follower-observer: a non-leader tab needs a way to detect that the
  // leader has finished provisioning so it can route the user to /home.
  // SessionContext already refreshes on auth events; we additionally flip
  // `provisioningDone` the moment a membership becomes visible. The
  // readiness probe + navigation effect below then takes over.
  useEffect(() => {
    if (provisioningDone) return;
    if (organizations.length > 0) {
      setProvisioningDone(true);
    }
  }, [organizations.length, provisioningDone]);

  // Leader: as soon as our local `isComplete` flips, signal followers and
  // arm the readiness probe.
  useEffect(() => {
    if (isComplete && !provisioningDone) {
      announceCompleted();
      setProvisioningDone(true);
    }
  }, [isComplete, provisioningDone, announceCompleted]);

  // Stamp the moment provisioning finishes + capture how many tabs were
  // racing this saga. Used by the diagnostics writer below.
  useEffect(() => {
    if (provisioningDone && provisioningDoneAtRef.current === null) {
      provisioningDoneAtRef.current = Date.now();
      try {
        // Best-effort tab count: the BroadcastChannel has no enumeration
        // API, so we fall back to "is there a sibling leader entry?". 1
        // means "this tab only"; >=2 means another tab also raced.
        let count = 1;
        if (typeof localStorage !== "undefined") {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith("ls_onboarding_leader:")) count += 1;
          }
        }
        tabCountAtStartRef.current = Math.max(1, count);
      } catch {
        tabCountAtStartRef.current = 1;
      }
    }
  }, [provisioningDone]);

  // ── Centralized post-provisioning navigation ──
  // Once the workspace is queryable AND our local UI has rendered the
  // "All set!" state, route to /home. If readiness times out (12s) we
  // surface the recovery card instead of letting the user spin forever.
  useEffect(() => {
    if (!provisioningDone) return;

    const writeDiagnostics = async (finalState: "ready" | "timed_out") => {
      if (diagnosticsWrittenRef.current || !user) return;
      diagnosticsWrittenRef.current = true;
      const startedAt = provisioningDoneAtRef.current ?? Date.now();
      const diagnostics = {
        readiness_ms: Date.now() - startedAt,
        tab_count: tabCountAtStartRef.current ?? 1,
        readiness_state: finalState,
        role: isLeader ? "leader" : isFollower ? "follower" : "solo",
        recorded_at: new Date().toISOString(),
      };
      try {
        await (supabase.from as any)("onboarding_attempts")
          .upsert({
            user_id: user.id,
            idempotency_key: idempotencyKeyRef.current,
            diagnostics,
          }, { onConflict: "user_id,idempotency_key" });
      } catch (e) {
        console.warn("[OnboardingSetup] diagnostics write failed:", e);
      }
    };

    if (readiness.state === "ready") {
      void writeDiagnostics("ready");
      // Small delay so the success animation can play once.
      const t = window.setTimeout(() => navigate("/home", { replace: true }), 600);
      return () => clearTimeout(t);
    }
    if (readiness.state === "timed_out") {
      void writeDiagnostics("timed_out");
      setError(
        "Your workspace is provisioned, but we couldn't load it. Please refresh — if this persists use the recovery options below.",
      );
      announceFailed("readiness_timeout");
    }
  }, [provisioningDone, readiness.state, navigate, announceFailed, user, isLeader, isFollower]);

  const handleComplete = () => {
    // Manual fallback if the user clicks through before the navigation
    // effect fires. Honors readiness state so we never dump them on a
    // /home that can't render yet.
    if (readiness.state === "ready" || organizations.length > 0) {
      navigate("/home", { replace: true });
    }
  };

  // Route guard is still evaluating, or has decided to redirect — render a
  // neutral loader and DO NOT mount the wizard. This prevents a flash of
  // the setup screen for already-onboarded users hitting the URL directly.
  if (gateState !== "allowed" || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">
            {gateState === "redirecting" ? "Redirecting..." : "Confirming your email..."}
          </p>
        </div>
      </div>
    );
  }

  // Show recovery card instead of dead-end "Setup Error" screen.
  // Three real options: retry, reset signup, or switch email cleanly.
  if (error) {
    return <SignupRecoveryCard message={error} email={user?.email} />;
  }

  // Show setup screen — leader (provisioning), follower (observing), or
  // anyone with provisioningDone in flight.
  //
  // UI/Gate sync (Defect 4a): the green "All set!" success state must
  // ONLY appear after `readiness.state === "ready"`. Previously we lit it
  // up the moment the RPC returned, which left followers (and leaders on
  // slow Realtime) staring at a "Done!" message while the actual route
  // hadn't moved — looked like the app was frozen.
  if (isProcessing || isComplete || isFollower || provisioningDone) {
    const showSuccess =
      (isComplete || provisioningDone) && readiness.state === "ready";
    return (
      <WorkspaceSetupScreen
        businessName={businessName}
        currentStep={currentStep}
        totalSteps={totalSteps}
        isComplete={showSuccess}
        onComplete={handleComplete}
      />
    );
  }

  // Default loading state
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">Preparing your workspace...</p>
      </div>
    </div>
  );
}

/**
 * Get selected apps from user metadata. Source of truth: auth.users.user_metadata.
 * Falls back to default app set when none specified.
 */
function getSelectedAppsFromMetadata(metadata?: Record<string, any> | null): string[] {
  if (metadata?.pending_selected_apps && Array.isArray(metadata.pending_selected_apps)) {
    return metadata.pending_selected_apps;
  }
  return getDefaultSelectedApps();
}

interface TeamInvitee {
  email: string;
  name: string;
  role: string;
}

/**
 * Get team invitees from user metadata. Source of truth: auth.users.user_metadata.
 */
function getTeamInviteesFromMetadata(metadata?: Record<string, any> | null): TeamInvitee[] {
  if (metadata?.pending_team_invitees && Array.isArray(metadata.pending_team_invitees)) {
    return metadata.pending_team_invitees;
  }
  return [];
}
