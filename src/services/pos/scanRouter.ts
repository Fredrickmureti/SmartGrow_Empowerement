/**
 * scanRouter — focus-aware target stack layered on top of scanBus.
 *
 * Components opt in by registering a target while they are "active" (typically
 * the focused barcode field, or a screen that wants every scan such as the
 * POS terminal cart). The topmost active target receives the next ScanEvent.
 *
 * When a registered target consumes a scan, the underlying `ScanEvent` is
 * marked in a WeakSet — legacy bus consumers (POSTerminal cart, etc.) check
 * `scanRouter.wasConsumed(event)` and skip to avoid double-dispatch.
 *
 * Per-target dedupe opt-out: a target may set `allowRepeats: true` to bypass
 * the cross-source 250 ms dedupe in `scanBus` while it is the topmost target.
 * This is required for Physical Count / Goods Receipt workflows where the
 * user legitimately scans the same SKU multiple times in quick succession.
 */

import { scanBus, type ScanEvent } from "./scanBus";
import { sendScanEvent } from "@/services/scanner/scanEventTelemetry";

/**
 * Workflow semantics for a scan target. Declarative — does not affect
 * runtime dispatch (precedence stays priority-based).
 */
export type ScanWorkflow = "identity" | "quantity" | "count" | "receive";

/**
 * High-level *intent* of a workspace's scan target. Promotes the
 * declarative `workflow` tag to a runtime contract (Plan Pillar A / P1+):
 * the router refuses to silently mount two conflicting non-identity
 * intents at the same priority, so a future module cannot re-introduce
 * POS-style qty++ semantics into a Sales / doc-authoring workspace.
 *
 *  - pos_sell         : POS checkout cart. Repeat = qty++.
 *  - doc_author       : Drafting documents (invoices, quotes, sales orders).
 *                       Repeat = focus existing line; NEVER auto-increment.
 *  - inventory_count  : Physical count reconciliation. Repeat = count++.
 *  - inventory_receive: Goods receipt confirmation. Repeat = received++.
 *  - identity         : Neutral — code IS the payload (enrollment, serial
 *                       intake, raw barcode field). Compatible with any
 *                       sibling intent.
 */
export type ScanIntent =
  | "pos_sell"
  | "doc_author"
  | "inventory_count"
  | "inventory_receive"
  | "identity";

export interface ScanTargetEntry {
  id: string;
  /** Higher priority wins ties (default 0). Focused inputs use 10. */
  priority: number;
  onScan: (e: ScanEvent) => void;
  /** Optional debug label for inspection. */
  label?: string;
  /**
   * Skip the cross-source 250 ms dedupe in `scanBus` for this target.
   * Use for repeat-scan workflows (counting, receiving). Default false.
   */
  allowRepeats?: boolean;
  /** Declarative workflow tag — see ScanWorkflow. */
  workflow?: ScanWorkflow;
  /**
   * Runtime intent contract — see ScanIntent. When two targets at the
   * SAME priority register with conflicting non-identity intents, the
   * router logs an error and the second registration is rejected.
   */
  intent?: ScanIntent;
  /**
   * Scanner Scope filter. Return false to reject an event; the router
   * walks down the stack to find another target that accepts. When
   * undefined (default), the target accepts every event — preserves
   * back-compat with Ambient-mode behavior.
   *
   * Wired by consumers based on the tenant's `scanner_scope_policies`
   * mode. In `ambient`, no consumer sets this. In `scoped`, focused
   * `<BarcodeInputField>` targets accept only workspace-session topics
   * (and keyboard / no-topic events); POSTerminal accepts only its own
   * register topic.
   */
  acceptsTopic?: (sourceTopic: string | undefined, source: ScanEvent["source"]) => boolean;
}

/** Two intents conflict if both are set, non-identity, and different. */
function intentsConflict(a: ScanIntent | undefined, b: ScanIntent | undefined): boolean {
  if (!a || !b) return false;
  if (a === "identity" || b === "identity") return false;
  return a !== b;
}


const stack: ScanTargetEntry[] = [];
let routerInstalled = false;
const consumedEvents = new WeakSet<ScanEvent>();

/**
 * Target-stack change notification.
 *
 * Presence surfaces (the WMS scan guidance bar) must know *which* target
 * owns the stream. Before this seam existed they polled `getActiveTargets()`
 * on a 1 s interval — one timer per mounted surface. The router now tells
 * them, so the UI is both instant and free when nothing changes.
 */
type StackListener = () => void;
const stackListeners = new Set<StackListener>();
let stackVersion = 0;

function notifyStackChanged() {
  stackVersion++;
  for (const fn of Array.from(stackListeners)) {
    try {
      fn();
    } catch (err) {
      console.error("[scanRouter] stack listener error", err);
    }
  }
}


/**
 * Active workspace scan context — supplies `register_id` / `session_id` to
 * `log_scan_event` so the DB SECURITY DEFINER fn can resolve org+branch.
 * Set by the topmost workspace screen on mount (POSTerminal sets
 * register_id; Physical Count / GRN scan screens will set session_id once
 * those screens wire scanRouter). When neither id is present we skip the
 * RPC entirely — the fn would drop the row anyway.
 */
export interface ActiveScanContext {
  register_id?: string | null;
  session_id?: string | null;
  device_id?: string | null;
  /**
   * Free-form workspace tag (e.g. "enrollment", "products", "sales",
   * "identifiers"). Used by `log_scan_event` to anchor the audit row to
   * the caller's active organization when no register / session exists.
   */
  workspace_id?: string | null;
}
let activeContext: ActiveScanContext | null = null;
let missingContextWarned = false;

function topActive(event?: ScanEvent): ScanTargetEntry | null {
  if (stack.length === 0) return null;
  // Sort by priority desc, then most-recently-registered first (stack
  // order). Walk until we find a target that accepts the event topic.
  const ordered = stack
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.priority - a.e.priority || b.i - a.i)
    .map((x) => x.e);
  if (!event) return ordered[0] ?? null;
  for (const t of ordered) {
    if (!t.acceptsTopic || t.acceptsTopic(event.sourceTopic, event.source)) {
      return t;
    }
  }
  return null;
}

function ensureInstalled() {
  if (routerInstalled) return;
  routerInstalled = true;
  scanBus.setDedupeBypass(() => topActive()?.allowRepeats === true);
  // Install as the privileged pre-listener so consumed-event marking
  // happens before any legacy `scanBus.on` consumer sees the event,
  // regardless of registration order.
  scanBus.setRouter((event) => {
    const target = topActive(event);
    if (!target) return;
    consumedEvents.add(event);
    try {
      target.onScan(event);
    } catch (err) {
      console.error("[scanRouter] target error", err);
    }
    // Fire-and-forget audit-trail emission (Group C #3). Skipped when
    // the active workspace has not supplied a register_id / session_id —
    // the DB fn would drop the row anyway.
    const ctx = activeContext;
    if (ctx && (ctx.register_id || ctx.session_id || ctx.workspace_id)) {
      void sendScanEvent({
        sessionId: ctx.session_id ?? null,
        registerId: ctx.register_id ?? null,
        workspaceId: ctx.workspace_id ?? null,
        deviceId: ctx.device_id ?? (event.source === "keyboard" ? "wedge" : event.source),
        code: event.code,
        seq: 0,
        decodedAt: event.at,
        verdict: "ok",
        workflow: target.workflow ?? null,
        source:
          event.source === "keyboard"
            ? "wedge"
            : event.source === "serial"
              ? "manual"
              : (event.source as "camera" | "manual" | "wedge" | "phone"),
      });
    } else if (!missingContextWarned) {
      missingContextWarned = true;
      console.warn(
        "[scanRouter] no active scan context — scan_events emission skipped. " +
          "Workspace screens must call scanRouter.setActiveContext({ register_id | session_id | workspace_id }) on mount.",
      );
    }
  });
}

export const scanRouter = {
  register(entry: ScanTargetEntry): () => void {
    ensureInstalled();
    // Intent contract (Plan P1+): reject a new registration whose intent
    // conflicts with any currently-mounted target at the SAME priority.
    // Identity intent is neutral and never conflicts. We log loudly so
    // the violation is visible in dev/test and in production telemetry.
    if (entry.intent) {
      const conflict = stack.find(
        (e) => e.priority === entry.priority && intentsConflict(e.intent, entry.intent),
      );
      if (conflict) {
        console.error(
          `[scanRouter] intent conflict: refusing to register "${entry.label ?? entry.id}" ` +
            `(intent=${entry.intent}, priority=${entry.priority}) ` +
            `because "${conflict.label ?? conflict.id}" (intent=${conflict.intent}) is already mounted at the same priority. ` +
            `Use a different priority or align intents. See .lovable/plan.md Pillar A.`,
        );
        return () => {};
      }
    }
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  },
  /** Was the given scan event already consumed by a registered target? */
  wasConsumed(event: ScanEvent): boolean {
    return consumedEvents.has(event);
  },
  /**
   * Set or clear the active workspace scan context. Last writer wins.
   * Pass `null` to clear (typically on screen unmount). When neither
   * `register_id` nor `session_id` is set, `scan_events` emission is
   * skipped for subsequently dispatched scans.
   */
  setActiveContext(ctx: ActiveScanContext | null): void {
    activeContext = ctx;
    if (ctx && (ctx.register_id || ctx.session_id || ctx.workspace_id)) {
      missingContextWarned = false;
    }
  },
  getActiveContext(): ActiveScanContext | null {
    return activeContext;
  },
  /**
   * Read-only view of the currently mounted scan targets, ordered the same way
   * dispatch resolves them (priority desc, then most recently registered).
   * Used by presence chips so an operator can see which surface owns the
   * scanner stream. Callers must not mutate the entries.
   */
  getActiveTargets(): ReadonlyArray<Readonly<ScanTargetEntry>> {
    return stack
      .map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.priority - a.e.priority || b.i - a.i)
      .map((x) => x.e);
  },
  /** Test helper. */
  _inspect() {
    return { stack: [...stack] };
  },
  _clear() {
    stack.length = 0;
    routerInstalled = false;
    activeContext = null;
    missingContextWarned = false;
    scanBus.setRouter(null);
    scanBus.setDedupeBypass(null);
  },
};
