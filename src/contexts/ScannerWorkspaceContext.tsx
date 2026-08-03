/**
 * ScannerWorkspaceContext — workspace-scoped scanner_session owner.
 *
 * Single source of truth for "the phone paired to this browser tab".
 * Mounted once inside `AuthenticatedShell`, this provider owns ONE
 * `scanner_session` per (businessId, branchId) and exposes it via
 * `useWorkspaceScanner()` to every form that wants to receive phone
 * scans (Product onboarding, Goods Receipt, Stock Transfer, Physical
 * Count, …).
 *
 * Why this exists:
 *   Previously each call site (`ScannerPairingButton`, the
 *   `ProductIdentifiersEditor` inside Add Item, etc.) called
 *   `useScannerSession()` itself. Every component mount minted a NEW
 *   `scanner_session` UUID and topic. A phone can only be bound to ONE
 *   session at a time via its pairing token, so opening Add Item after
 *   pairing on the toolbar silently created a second session and forced
 *   the user to re-pair. Creating each subsequent product re-paired
 *   again. Repro: see docs/audit/2026-05-19 scanner workspace audit
 *   (recorded in .lovable/plan.md).
 *
 *   Hoisting ownership to the workspace makes the device behave like
 *   real enterprise hardware (Odoo / Shopify POS / Square / Zebra
 *   DataWedge): pair once, every focused <BarcodeInputField> on every
 *   form is a passive consumer via the existing scanBus + scanRouter.
 *
 * Lifecycle:
 *   - The session is minted lazily — only the first time something
 *     reads `session.sessionId` via the hook OR `openPairing()` is
 *     called. Until then we are inert (no RPC, no realtime subscription).
 *   - When `businessId` or `branchId` changes we revoke the old session
 *     and mint a new one (correct: a phone paired to business A must
 *     NOT inject scans into business B).
 *   - The QR pairing dialog itself is rendered at the provider level so
 *     any caller just calls `openPairing()`; closing the dialog does
 *     NOT revoke (channel survives — that's the whole point).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import {
  useScannerSession,
  type UseScannerSessionResult,
} from "@/hooks/scanner/useScannerSession";
import { ScannerSessionDialog } from "@/components/scanner/ScannerSessionDialog";
import { useScannerScopeMode, type ScannerScopeMode } from "@/hooks/scanner/useScannerScopePolicy";
import type { ScanEvent } from "@/services/pos/scanBus";
import { useLocalScan } from "@/hooks/scanner/useLocalScan";
import type {
  ScannerDeviceMode,
  ScannerDeviceModePreference,
} from "@/services/scanner/camera/deviceMode";

interface Ctx {
  /** Underlying session — null while inert (no pairing requested yet). */
  session: UseScannerSessionResult | null;
  /** True when at least one phone is currently subscribed to the channel. */
  isPaired: boolean;
  /** Number of paired phones (usually 0 or 1). */
  connectedCount: number;
  /** Open the QR pairing dialog (mints the session on first call). */
  openPairing: (label?: string) => void;
  /** Effective Scanner Scope mode for the active business. */
  scopeMode: ScannerScopeMode;
  /**
   * Workspace realtime topic (`scan:session:<uuid>`) once the session
   * has been minted. Null while inert.
   */
  workspaceTopic: string | null;
  /**
   * Ready-made `acceptsTopic` predicate for use with `useScanTarget` /
   * `<BarcodeInputField>`. In Ambient mode returns undefined (accept
   * everything). In Scoped mode accepts only the workspace topic plus
   * keyboard / manual scans (which have no topic). POS register scans
   * are dropped at the field level.
   */
  acceptsTopic?: (sourceTopic: string | undefined, source: ScanEvent["source"]) => boolean;
  /**
   * Is THIS device the scanner (handheld: its own camera) or a workstation
   * driven by a paired phone / USB gun? Decides whether scan surfaces offer
   * the local-camera affordance. See `services/scanner/camera/deviceMode`.
   */
  deviceMode: ScannerDeviceMode;
  deviceModePreference: ScannerDeviceModePreference;
  setDeviceModePreference: (next: ScannerDeviceModePreference) => void;
}

const ScannerWorkspaceContext = createContext<Ctx | undefined>(undefined);

const DEFAULT_LABEL = "Workspace scanner";

interface ProviderProps {
  children: ReactNode;
}

export function ScannerWorkspaceProvider({ children }: ProviderProps) {
  // Soft-read both contexts so the provider is safe to mount above pages
  // that don't have a business yet (e.g. /onboarding-setup). Missing
  // context → no session.
  const businessCtx = useContextSafe();
  const branchCtx = useBranchSafe();
  const businessId = businessCtx?.currentBusiness?.id ?? "";
  const branchId = branchCtx?.currentBranch?.id ?? null;

  const [armed, setArmed] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [label, setLabel] = useState<string>(DEFAULT_LABEL);

  // Reset armed-state when the workspace switches — the new business
  // needs its own pairing decision.
  const lastKeyRef = useRef<string>("");
  const session = useScannerSession({
    enabled: armed && !!businessId,
    businessId,
    branchId,
    label,
  });

  const scopeMode = useScannerScopeMode(businessId || null);
  const { mode: deviceMode, preference: deviceModePreference, setPreference: setDeviceModePreference } =
    useLocalScan();
  const workspaceTopic = session.sessionId ? `scan:session:${session.sessionId}` : null;

  const acceptsTopic = useMemo(() => {
    if (scopeMode === "ambient") return undefined;
    return (sourceTopic: string | undefined, source: ScanEvent["source"]) => {
      // Keyboard / manual / serial / native: no topic → always accept.
      if (!sourceTopic) return true;
      // POS register topics are forbidden in workspace fields.
      if (sourceTopic.startsWith("pos:scan:")) return false;
      // Workspace-session topics: only the one matching this workspace.
      if (sourceTopic.startsWith("scan:session:")) {
        return workspaceTopic !== null && sourceTopic === workspaceTopic;
      }
      return true;
    };
  }, [scopeMode, workspaceTopic]);

  // Reset armed-state when the workspace switches. If a phone is currently
  // paired, fire a reason-tagged revoke first so the phone surfaces a
  // clear "switched companies/branches" message instead of a bare
  // "disconnected".
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    const key = `${businessId}::${branchId ?? ""}`;
    const prev = lastKeyRef.current;
    if (prev && prev !== key) {
      const [prevBiz, prevBranch] = prev.split("::");
      const [, curBranch] = key.split("::");
      const businessChanged = prevBiz !== businessId;
      const branchChanged = !businessChanged && prevBranch !== curBranch;
      const reason: "business_changed" | "branch_changed" | "manual" = businessChanged
        ? "business_changed"
        : branchChanged
          ? "branch_changed"
          : "manual";
      const s = sessionRef.current;
      if (s && s.connectedDevices.length > 0) {
        void s.revoke(reason);
      }
      setArmed(false);
      setPairingOpen(false);
    }
    lastKeyRef.current = key;
  }, [businessId, branchId]);

  // Cross-tab "reopen pairing dialog" signal from the phone's
  // disconnected/pair-again screen. Only acts when this workspace has a
  // business in scope.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("scanner-workspace");
    const onMsg = (ev: MessageEvent) => {
      const data = ev?.data as { type?: string; label?: string } | null;
      if (!data || data.type !== "reopen") return;
      if (!businessId) return;
      if (data.label && data.label.trim()) setLabel(data.label);
      setArmed(true);
      setPairingOpen(true);
    };
    bc.addEventListener("message", onMsg);
    return () => {
      bc.removeEventListener("message", onMsg);
      bc.close();
    };
  }, [businessId]);

  const openPairing = useCallback((nextLabel?: string) => {
    // Label is session metadata. Once a workspace session exists/arms, do
    // not relabel it from every consumer button (Products, Invoices, etc.)
    // or the session hook can churn while a phone is already paired.
    if (!armed && nextLabel && nextLabel.trim()) setLabel(nextLabel);
    setArmed(true);
    setPairingOpen(true);
  }, [armed]);

  const connectedCount = session.connectedDevices.length;
  const isPaired = connectedCount > 0;

  // Provide a non-null `session` reference once armed, even before the
  // RPC returns, so consumers can wire `session={...}` immediately.
  const value = useMemo<Ctx>(
    () => ({
      session: armed ? session : null,
      isPaired,
      connectedCount,
      openPairing,
      scopeMode,
      workspaceTopic,
      acceptsTopic,
      deviceMode,
      deviceModePreference,
      setDeviceModePreference,
    }),
    [
      armed,
      session,
      isPaired,
      connectedCount,
      openPairing,
      scopeMode,
      workspaceTopic,
      acceptsTopic,
      deviceMode,
      deviceModePreference,
      setDeviceModePreference,
    ],
  );

  return (
    <ScannerWorkspaceContext.Provider value={value}>
      {children}
      {armed && businessId ? (
        <ScannerSessionDialog
          open={pairingOpen}
          onOpenChange={setPairingOpen}
          businessId={businessId}
          branchId={branchId}
          label={label}
          session={session}
          mode="persistent"
        />
      ) : null}
    </ScannerWorkspaceContext.Provider>
  );
}

export function useWorkspaceScanner(): Ctx {
  const ctx = useContext(ScannerWorkspaceContext);
  if (!ctx) {
    // Soft-fail: outside the provider (tests, storybook) → inert shim
    // so consumers don't crash. They simply won't be able to pair.
    return {
      session: null,
      isPaired: false,
      connectedCount: 0,
      openPairing: () => {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[useWorkspaceScanner] called outside ScannerWorkspaceProvider — pairing is unavailable.",
          );
        }
      },
      scopeMode: "ambient",
      workspaceTopic: null,
      acceptsTopic: undefined,
      deviceMode: "workstation",
      deviceModePreference: "auto",
      setDeviceModePreference: () => {},
    };
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Safe context readers — never throw if provider tree is incomplete   */
/* ------------------------------------------------------------------ */

function useContextSafe() {
  try {
    return useBusinesses();
  } catch {
    return null;
  }
}

function useBranchSafe() {
  try {
    return useBranch();
  } catch {
    return null;
  }
}
