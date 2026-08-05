/**
 * trace — the ONE performance-tracing seam for the printing lifecycle.
 *
 * Phase 1 of the POS printing latency programme. Before any stage of the
 * pipeline is moved, removed, or made asynchronous, every stage must be
 * measurable. This module gives the whole pipeline one vocabulary:
 *
 *   await withSpan('render.document', () => renderDocumentRecord(...), attrs, correlationId)
 *
 * Design constraints, in priority order:
 *
 *  1. **Never affect the thing being measured.** A span never throws, never
 *     awaits a network call inline, and never changes the value the wrapped
 *     function returns. If tracing breaks, printing still works.
 *  2. **Correlation over sampling.** Spans are grouped by the printing
 *     `correlationId` that already flows through `PrintService`, so one
 *     cashier action produces one waterfall rather than a pile of unrelated
 *     timings.
 *  3. **Concurrency-safe.** Two prints in flight at once (a label while an
 *     invoice renders, N copies of a receipt) must not share or clobber one
 *     another's spans. The active trace is therefore resolved by an explicit
 *     `correlationId` handle, not by a module-global "current trace". The
 *     global is retained only as a best-effort fallback for call sites that
 *     have no correlation id in scope, and it is never used when a handle is
 *     supplied.
 *  4. **One flush, off the hot path.** Spans accumulate in memory and are
 *     flushed to `print_traces` after the trace closes, in the background.
 *     The operator never waits for telemetry.
 *
 * Anything that wants to know "where did the time go?" reads
 * `print_traces` by `correlation_id`. Nothing in the app should measure
 * printing latency any other way.
 */
import { supabase } from '@/integrations/supabase/client';

export interface TraceSpan {
  /** Dotted stage name, e.g. `render.document`, `relay.enqueue`. */
  name: string;
  /** Milliseconds since the trace started. */
  startOffsetMs: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** Small, non-PII facts: byte counts, copy index, transport kind. */
  attributes?: Record<string, string | number | boolean | null>;
}

export interface TraceContext {
  correlationId: string;
  /** Business label for the waterfall, e.g. `pos_receipt`, `sales_invoice`. */
  label: string;
  startedAt: number;
  spans: TraceSpan[];
  attributes: Record<string, string | number | boolean | null>;
}

/**
 * How a call site names the trace it is recording into: the context itself,
 * its correlation id, or nothing (fall back to the ambient trace).
 */
export type TraceRef = TraceContext | string | null | undefined;

const MAX_SPANS = 200;
/** Safety valve: a trace whose owner never closes it must not leak forever. */
const MAX_OPEN_TRACES = 64;

/** Open traces, keyed by correlation id. Concurrency lives here. */
const open = new Map<string, TraceContext>();

/**
 * Ambient trace for call sites with no correlation id in scope. Only ever a
 * fallback — anything on the printing hot path passes an explicit handle.
 */
let ambient: TraceContext | null = null;

/** The ambient trace, if any. Prefer an explicit `TraceRef`. */
export function currentTrace(): TraceContext | null {
  return ambient;
}

/** Resolve a handle to a live trace, or null when there is nothing to record into. */
function resolve(ref: TraceRef): TraceContext | null {
  if (!ref) return ambient;
  if (typeof ref === 'string') return open.get(ref) ?? null;
  return ref;
}

function newCorrelationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function now(): number {
  try {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Record one stage. Safe to call outside a trace — the timing is simply
 * dropped, so instrumentation can live in shared modules that are also
 * used off the printing path.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T> | T,
  attributes?: Record<string, string | number | boolean | null>,
  trace?: TraceRef,
): Promise<T> {
  const ctx = resolve(trace);
  if (!ctx) return await fn();

  const start = now();
  try {
    const value = await fn();
    push(ctx, name, start, true, undefined, attributes);
    return value;
  } catch (err) {
    push(ctx, name, start, false, err instanceof Error ? err.message : String(err), attributes);
    throw err;
  }
}

/** Record a stage that was measured elsewhere (agent-reported, for example). */
export function addSpan(
  name: string,
  durationMs: number,
  attributes?: Record<string, string | number | boolean | null>,
  ok = true,
  trace?: TraceRef,
): void {
  const ctx = resolve(trace);
  if (!ctx) return;
  if (ctx.spans.length >= MAX_SPANS) return;
  ctx.spans.push({
    name,
    startOffsetMs: Math.round(now() - ctx.startedAt),
    durationMs: Math.round(durationMs),
    ok,
    attributes,
  });
}

/** Attach a fact to the whole trace (document type, copies, transport…). */
export function annotateTrace(
  attributes: Record<string, string | number | boolean | null>,
  trace?: TraceRef,
): void {
  const ctx = resolve(trace);
  if (!ctx) return;
  Object.assign(ctx.attributes, attributes);
}

function push(
  trace: TraceContext,
  name: string,
  start: number,
  ok: boolean,
  error: string | undefined,
  attributes: Record<string, string | number | boolean | null> | undefined,
): void {
  if (trace.spans.length >= MAX_SPANS) return;
  trace.spans.push({
    name,
    startOffsetMs: Math.round(start - trace.startedAt),
    durationMs: Math.round(now() - start),
    ok,
    error: error?.slice(0, 300),
    attributes,
  });
}

/**
 * Run `fn` inside a fresh trace and flush the result in the background.
 *
 * Re-entering with a correlation id that is already open joins that trace —
 * a reprint triggered from inside a print still produces one waterfall —
 * while two different correlation ids running at the same time keep
 * completely separate span lists.
 */
export async function withTrace<T>(
  input: {
    label: string;
    correlationId?: string;
    attributes?: Record<string, string | number | boolean | null>;
  },
  fn: (ctx: TraceContext) => Promise<T>,
): Promise<T> {
  const correlationId = input.correlationId ?? newCorrelationId();

  const existing = open.get(correlationId);
  if (existing) {
    Object.assign(existing.attributes, input.attributes ?? {});
    return await fn(existing);
  }

  const trace: TraceContext = {
    correlationId,
    label: input.label,
    startedAt: now(),
    spans: [],
    attributes: { ...(input.attributes ?? {}) },
  };

  if (open.size >= MAX_OPEN_TRACES) {
    // Oldest first — a leaked trace must never starve a live one.
    const oldest = open.keys().next().value as string | undefined;
    if (oldest) open.delete(oldest);
  }
  open.set(correlationId, trace);

  const previousAmbient = ambient;
  ambient = trace;
  try {
    return await fn(trace);
  } finally {
    ambient = previousAmbient;
    open.delete(correlationId);
    void flush(trace);
  }
}

/**
 * Persist a finished trace. Fire-and-forget by contract: telemetry that
 * can fail a print is worse than no telemetry.
 */
export async function flush(trace: TraceContext): Promise<void> {
  const totalMs = Math.round(now() - trace.startedAt);
  try {
    // eslint-disable-next-line no-console
    console.info('[print.trace]', {
      correlationId: trace.correlationId,
      label: trace.label,
      totalMs,
      spans: trace.spans.map((s) => `${s.name}=${s.durationMs}ms`),
    });
  } catch { /* console failures never matter */ }

  try {
    const { error } = await supabase.from('print_traces' as never).insert({
      correlation_id: trace.correlationId,
      label: trace.label,
      total_ms: totalMs,
      spans: trace.spans,
      attributes: trace.attributes,
    } as never);
    if (error) {
      // Silent telemetry loss is how Phase 1 shipped a tracer that recorded
      // nothing for weeks. Never thrown, never awaited on the hot path — but
      // never invisible either.
      // eslint-disable-next-line no-console
      console.warn('[print.trace] persist failed', error.message);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[print.trace] persist threw', err instanceof Error ? err.message : String(err));
  }
}
