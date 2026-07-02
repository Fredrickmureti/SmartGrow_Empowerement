/**
 * Hardware exec audit log writer.
 *
 * Fire-and-forget tenant-scoped insert into `hardware_exec_log` for every
 * `hardwareClient.exec` call. Also keeps a 50-entry in-memory ring buffer
 * so the Diagnostics page can render "recent commands" without a round
 * trip when there are no historical rows yet.
 *
 * Audit Wave 9d.7 (P4) — writes are now BATCHED:
 *   - Entries are buffered in a small queue and flushed every 2 s or
 *     when the queue reaches 25 entries, whichever comes first.
 *   - The Supabase session (and therefore `actor_user_id`) is resolved
 *     ONCE per flush, not once per command.
 * Result: at 100 sales/h with 8 commands per sale, this collapses ~800
 * synchronous `getSession()` + insert round-trips into roughly 32 batched
 * inserts per hour per terminal.
 *
 * Never blocks the command path: log writes happen asynchronously off the
 * critical path. Errors are swallowed (RLS denials, offline, etc.) — losing
 * an audit row must not break a print job.
 */
import { supabase } from '@/integrations/supabase/client';

export interface HardwareExecLogEntry {
  at: number;
  role: string;
  op: string;
  ok: boolean;
  durationMs: number;
  errorMessage?: string;
  idempotencyKey?: string;
  runtimeReason?: string;
  /** Track 1 audit linkage — surfaced in ring buffer too so diagnostics show provenance. */
  sourceDocType?: string | null;
  sourceDocId?: string | null;
  businessEventId?: string | null;
  isReprint?: boolean;
}

const RING: HardwareExecLogEntry[] = [];
const RING_MAX = 50;

export function getRecentExecLog(): ReadonlyArray<HardwareExecLogEntry> {
  return RING.slice();
}

interface LogInput extends HardwareExecLogEntry {
  orgId: string | null;
  businessId: string | null;
  actorUserId: string | null;
}

// ─── Batching ────────────────────────────────────────────────────────────
const BUFFER: LogInput[] = [];
const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_BATCH_SIZE = 25;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Cache the resolved user id between flushes; refresh on auth events.
let cachedUserId: string | null = null;
let lastSessionResolveAt = 0;
const SESSION_TTL_MS = 60_000;

async function resolveUserId(): Promise<string | null> {
  if (cachedUserId && Date.now() - lastSessionResolveAt < SESSION_TTL_MS) {
    return cachedUserId;
  }
  try {
    const session = await supabase.auth.getSession();
    cachedUserId = session.data.session?.user?.id ?? null;
    lastSessionResolveAt = Date.now();
  } catch {
    cachedUserId = null;
  }
  return cachedUserId;
}

// Invalidate session cache on auth changes.
try {
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedUserId = session?.user?.id ?? null;
    lastSessionResolveAt = Date.now();
  });
} catch { /* SSR or test envs without an auth bus */ }

async function flushBuffer(): Promise<void> {
  if (BUFFER.length === 0) return;
  const drained = BUFFER.splice(0, BUFFER.length);
  const userId = await resolveUserId();
  const rows = drained
    .filter((e) => e.orgId)
    .map((e) => ({
      org_id: e.orgId,
      business_id: e.businessId,
      actor_user_id: e.actorUserId ?? userId,
      role: e.role,
      op: e.op,
      ok: e.ok,
      duration_ms: e.durationMs,
      error_message: e.errorMessage ?? null,
      idempotency_key: e.idempotencyKey ?? null,
      runtime_reason: e.runtimeReason ?? null,
      source_doc_type: e.sourceDocType ?? null,
      source_doc_id: e.sourceDocId ?? null,
      business_event_id: e.businessEventId ?? null,
      is_reprint: e.isReprint ?? false,
    }));
  if (rows.length === 0) return;
  try {
    const { error } = await supabase.from('hardware_exec_log').insert(rows);
    if (error) {
      // eslint-disable-next-line no-console
      console.debug('[hardware_exec_log] batched insert failed:', error.message);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.debug('[hardware_exec_log] batched insert threw:', (e as Error).message);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

export function recordHardwareExec(input: LogInput): void {
  const entry: HardwareExecLogEntry = {
    at: input.at,
    role: input.role,
    op: input.op,
    ok: input.ok,
    durationMs: input.durationMs,
    errorMessage: input.errorMessage,
    idempotencyKey: input.idempotencyKey,
    runtimeReason: input.runtimeReason,
    sourceDocType: input.sourceDocType ?? null,
    sourceDocId: input.sourceDocId ?? null,
    businessEventId: input.businessEventId ?? null,
    isReprint: input.isReprint ?? false,
  };
  RING.push(entry);
  if (RING.length > RING_MAX) RING.shift();

  if (!input.orgId) return;
  BUFFER.push(input);
  if (BUFFER.length >= FLUSH_BATCH_SIZE) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    void flushBuffer();
  } else {
    scheduleFlush();
  }
}

/** Test/cleanup helper: forces an immediate drain. */
export async function flushHardwareExecLog(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flushBuffer();
}

// ─── Active org/business context ─────────────────────────────────────────
let activeContext: { orgId: string | null; businessId: string | null } = {
  orgId: null,
  businessId: null,
};

export function setHardwareExecContext(ctx: { orgId: string | null; businessId: string | null }): void {
  activeContext = { ...ctx };
}

export function getHardwareExecContext(): { orgId: string | null; businessId: string | null } {
  return activeContext;
}
