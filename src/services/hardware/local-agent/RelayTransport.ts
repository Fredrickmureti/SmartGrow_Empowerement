/**
 * RelayTransport — AccrualFlow Edge Phase 2.
 *
 * Enqueues a hardware job into `public.edge_jobs` for a specific workstation
 * and awaits the agent's result via Supabase Realtime, falling back to
 * polling if the Realtime channel is not established in time.
 *
 * This transport is the primary path for production browsers on
 * `https://www.accrualflow.systems`, where mixed-content rules forbid a
 * direct `fetch('http://127.0.0.1:8043/...')` from an HTTPS origin. The
 * legacy loopback HTTP path in `AgentClient` stays as a fallback for LAN /
 * dev workflows and for latency-sensitive operations where the round-trip
 * through Supabase is undesirable.
 *
 * Contract:
 *   const relay = new RelayTransport(supabase, { workstationId, organizationId });
 *   const result = await relay.dispatch({ role, op, payload, idempotencyKey?, deadlineMs? });
 *
 * The `result` shape mirrors what the agent returns from the corresponding
 * route (see `agent/src/routes/*`), so callers can treat relay and loopback
 * responses interchangeably.
 */

import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { withSpan, addSpan } from '@/services/observability/trace';

export type EdgeRole =
  | 'print'
  | 'test'
  | 'usb_print'
  | 'discover'
  | 'usb_devices'
  | 'status';

export interface RelayConfig {
  workstationId: string;
  organizationId: string;
  /** Default deadline for jobs in ms; jobs exceeding this are marked expired server-side. */
  defaultDeadlineMs?: number;
}

export interface DispatchArgs {
  role: EdgeRole;
  op?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  deadlineMs?: number;
  /**
   * Extend the deadline by the number of jobs already waiting for this
   * workstation. Without it, invoice 4 of a burst is judged against invoice
   * 1's clock and gets expired before the agent ever reaches it.
   */
  queueAware?: boolean;
  /**
   * Trace key of the originating print. Without it, relay spans attach to
   * whichever trace happens to be ambient — wrong once two prints overlap.
   */
  correlationId?: string;
}

export interface DispatchResult<T = unknown> {
  jobId: string;
  status: 'done' | 'error' | 'expired';
  result: T | null;
  error: string | null;
  lastKnownJobStatus?: string | null;
}

const DEFAULT_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 1_500;
/** Extra allowance per job already queued ahead of this one. */
const QUEUE_ALLOWANCE_MS = 4_000;
/** Cap on the queue-aware extension so a wedged queue can't stall the UI. */
const MAX_QUEUE_ALLOWANCE_MS = 40_000;
/**
 * The agent polls every 1.5 s and stamps `workstations.last_seen_at` on each
 * poll. If the newest stamp is older than this, the workstation is not
 * listening and queueing a job would just burn the caller's deadline.
 */
const LIVENESS_WINDOW_MS = 20_000;
/**
 * How long a successful liveness read stays usable without re-reading.
 * The agent stamps `last_seen_at` continuously, so a presence check that was
 * true a moment ago is still true — and paying a cloud round trip for it in
 * front of every print is pure dead time. A *negative* result is never
 * cached: an agent that just came back online must be usable immediately.
 */
const LIVENESS_CACHE_MS = 5_000;

export class RelayTransport {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly config: RelayConfig,
  ) {}

  /**
   * Fail fast when the target workstation is not polling. Without this the
   * UI spins for the whole deadline on an offline/unauthorized agent and the
   * job sits in `edge_jobs` forever.
   */
  /** Last positive presence read, reused inside `LIVENESS_CACHE_MS`. */
  private _presence: { at: number; lastSeenAt: string | null } | null = null;
  /** Jobs this transport has enqueued and not yet settled. */
  private _inFlight = 0;

  private async _liveness(): Promise<{ alive: boolean; lastSeenAt: string | null }> {
    const cached = this._presence;
    if (cached && Date.now() - cached.at < LIVENESS_CACHE_MS) {
      return { alive: true, lastSeenAt: cached.lastSeenAt };
    }
    const { data, error } = await this.supabase
      .from('workstations')
      .select('last_seen_at')
      .eq('id', this.config.workstationId)
      .maybeSingle();
    if (error || !data) return { alive: false, lastSeenAt: null };
    const lastSeenAt = (data as { last_seen_at: string | null }).last_seen_at;
    if (!lastSeenAt) return { alive: false, lastSeenAt: null };
    const age = Date.now() - new Date(lastSeenAt).getTime();
    const alive = age <= LIVENESS_WINDOW_MS;
    this._presence = alive ? { at: Date.now(), lastSeenAt } : null;
    return { alive, lastSeenAt };
  }

  /** Enqueue a job and wait for the agent to complete it. */
  async dispatch<T = unknown>(args: DispatchArgs): Promise<DispatchResult<T>> {
    // Liveness and queue depth are two independent reads. Running them in
    // series put a full extra cloud round trip in front of every single
    // relay print for information that does not depend on the other.
    const allowance = args.queueAware ? this._queueAllowanceMs() : 0;
    const liveness = await withSpan(
      'relay.preflight',
      () => this._liveness(),
      { queue_allowance_ms: allowance, in_flight: this._inFlight },
      args.correlationId,
    );

    if (!liveness.alive) {
      const seen = liveness.lastSeenAt
        ? `last polled ${Math.round((Date.now() - new Date(liveness.lastSeenAt).getTime()) / 1000)}s ago`
        : 'never polled';
      return {
        jobId: '',
        status: 'error',
        result: null,
        error: `agent_offline: this workstation is not polling AccrualFlow (${seen}). Open the AccrualFlow Edge desktop app on that machine — if it is already running, re-issue its workstation secret from Identity so the relay can re-authorise.`,
      };
    }

    const baseDeadlineMs = Math.max(1_000, args.deadlineMs ?? this.config.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS);
    const deadlineMs = baseDeadlineMs + allowance;
    const deadlineAt = new Date(Date.now() + deadlineMs).toISOString();


    const insertRow = {
      organization_id: this.config.organizationId,
      workstation_id: this.config.workstationId,
      role: args.role,
      op: args.op ?? 'exec',
      payload: args.payload ?? {},
      idempotency_key: args.idempotencyKey ?? null,
      deadline_at: deadlineAt,
    };

    // Idempotency: if a job with the same (org, ws, key) already exists we
    // reuse it. The unique index lets the insert fail with 23505 which we
    // translate into a lookup rather than a hard error.
    const { data: inserted, error: insertErr } = await withSpan(
      'relay.enqueue',
      () =>
        this.supabase
          .from('edge_jobs')
          .insert(insertRow)
          .select('id, status, result, error')
          .single(),
      { role: args.role, op: args.op ?? 'exec' },
      args.correlationId,
    );


    let jobId: string | null = null;
    if (insertErr) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((insertErr as any).code === '23505' && args.idempotencyKey) {
        const { data: existing } = await this.supabase
          .from('edge_jobs')
          .select('id, status, result, error')
          .eq('organization_id', this.config.organizationId)
          .eq('workstation_id', this.config.workstationId)
          .eq('idempotency_key', args.idempotencyKey)
          .maybeSingle();
        if (existing) {
          if (existing.status === 'done' || existing.status === 'error' || existing.status === 'expired') {
            return this._finalize<T>(existing.id, existing.status as DispatchResult['status'], existing.result as T | null, existing.error);
          }
          jobId = existing.id;
        }
      }
      if (!jobId) {
        return {
          jobId: '',
          status: 'error',
          result: null,
          error: `relay_insert_failed: ${insertErr.message}`,
        };
      }
    } else {
      jobId = inserted!.id;
      if (inserted!.status === 'done' || inserted!.status === 'error' || inserted!.status === 'expired') {
        return this._finalize<T>(jobId, inserted!.status as DispatchResult['status'], inserted!.result as T | null, inserted!.error);
      }
    }

    // The single biggest unknown in the waterfall: how long the workstation
    // takes to claim the row and finish the physical write.
    const awaited = await withSpan(
      'relay.agent_roundtrip',
      () => this._await<T>(jobId, deadlineMs),
      undefined,
      args.correlationId,
    );

    // The agent reports its own stage timings (relay queue wait, handler,
    // printer queue wait, socket write) inside the result. Replay them into
    // the caller's trace so the waterfall covers the whole journey instead of
    // stopping at the cloud boundary.
    return this._absorbAgentSpans(awaited, args.correlationId);

  }

  /**
   * Lift `_agent_spans` out of the job result into the print trace.
   *
   * The key is stripped from the returned result so callers keep seeing the
   * plain route response shape they had before tracing existed.
   */
  private _absorbAgentSpans<T>(
    res: DispatchResult<T>,
    correlationId?: string,
  ): DispatchResult<T> {
    const raw = res.result as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return res;
    const obj = raw as Record<string, unknown>;
    const spans = obj._agent_spans;
    if (!Array.isArray(spans)) return res;
    for (const span of spans as Array<Record<string, unknown>>) {
      if (!span || typeof span.name !== 'string') continue;
      addSpan(
        span.name,
        Number(span.durationMs) || 0,
        (span.attributes as Record<string, string | number | boolean | null>) ?? undefined,
        span.ok !== false,
        correlationId,
      );
    }
    const { _agent_spans: _drop, ...rest } = obj;
    void _drop;
    return { ...res, result: rest as T };
  }

  private _finalize<T>(jobId: string, status: DispatchResult['status'], result: T | null, error: string | null): DispatchResult<T> {
    return { jobId, status, result, error };
  }

  /**
   * How much extra time this job needs because of work already ahead of it.
   * Counts live (queued / in-progress) rows for this workstation.
   */
  /**
   * Deadline extension for jobs already queued ahead of this one.
   *
   * This used to be a `count(*)` over `edge_jobs` on every dispatch — a cloud
   * round trip in front of every print to learn something this client already
   * knows. A burst comes from one browser tab, so the outstanding jobs it has
   * itself enqueued are the queue that matters. No round trip, same guarantee
   * that job 4 of a burst is not judged against job 1's clock.
   */
  private _queueAllowanceMs(): number {
    return Math.min(this._inFlight * QUEUE_ALLOWANCE_MS, MAX_QUEUE_ALLOWANCE_MS);
  }

  private async _await<T>(jobId: string, deadlineMs: number): Promise<DispatchResult<T>> {
    // Race: Realtime UPDATE on this row, polling every POLL_INTERVAL_MS,
    // and a hard timeout at deadlineMs + 2s (server-side expiry runs on
    // each poll from the agent, so we allow a small grace period).
    return new Promise<DispatchResult<T>>((resolve) => {
      let settled = false;
      let lastKnownJobStatus: string | null = null;
      const finish = (r: DispatchResult<T>) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(hardTimer);
        void this.supabase.removeChannel(channel);
        resolve(r);
      };

      const check = (row: { id: string; status: string; result: unknown; error: string | null }) => {
        if (row.id !== jobId) return;
        lastKnownJobStatus = row.status;
        if (row.status === 'done' || row.status === 'error' || row.status === 'expired') {
          finish(this._finalize<T>(jobId, row.status as DispatchResult['status'], row.result as T | null, row.error));
        }
      };

      const channel: RealtimeChannel = this.supabase
        .channel(`edge_job:${jobId}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'edge_jobs', filter: `id=eq.${jobId}` },
          (payload) => check(payload.new as { id: string; status: string; result: unknown; error: string | null }),
        )
        .subscribe();

      const pollTimer = setInterval(async () => {
        const { data } = await this.supabase
          .from('edge_jobs')
          .select('id, status, result, error')
          .eq('id', jobId)
          .maybeSingle();
        if (data) check(data as { id: string; status: string; result: unknown; error: string | null });
      }, POLL_INTERVAL_MS);

      const hardTimer = setTimeout(() => {
        // Don't leave the row queued forever — an unclaimed job that nobody
        // is waiting for is what filled `edge_jobs` with orphans before.
        void this.supabase
          .from('edge_jobs')
          .update({ status: 'expired', error: 'relay_timeout: no agent response', updated_at: new Date().toISOString() })
          .eq('id', jobId)
          .in('status', ['queued', 'in_progress']);
        const state = lastKnownJobStatus ?? 'queued';
        const reason = state === 'queued'
          ? 'relay_timeout_unclaimed: the desktop agent is authorized but its cloud poll loop did not claim this job before the deadline.'
          : 'relay_timeout_in_progress: the desktop agent claimed this job but did not post a result before the deadline.';
        finish({
          jobId,
          status: 'error',
          result: null,
          lastKnownJobStatus: state,
          error: `${reason} Check AccrualFlow Edge logs; if this is a local simulator on 127.0.0.1:9100, use the direct loopback test path.`,
        });
      }, deadlineMs + 2_000);
    });
  }
}
