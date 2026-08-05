/**
 * trace — the ONE performance-tracing seam for the printing lifecycle.
 *
 * Phase 1 of the POS printing latency programme. Before any stage of the
 * pipeline is moved, removed, or made asynchronous, every stage must be
 * measurable. This module gives the whole pipeline one vocabulary:
 *
 *   await withSpan('render.document', () => renderDocumentRecord(...))
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
 *  3. **One flush, off the hot path.** Spans accumulate in memory and are
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

const MAX_SPANS = 200;

let current: TraceContext | null = null;

/** The trace spans are being recorded into, if any. */
export function currentTrace(): TraceContext | null {
  return current;
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
): Promise<T> {
  const trace = current;
  if (!trace) return await fn();

  const start = now();
  try {
    const value = await fn();
    push(trace, name, start, true, undefined, attributes);
    return value;
  } catch (err) {
    push(trace, name, start, false, err instanceof Error ? err.message : String(err), attributes);
    throw err;
  }
}

/** Record a stage that was measured elsewhere (agent-reported, for example). */
export function addSpan(
  name: string,
  durationMs: number,
  attributes?: Record<string, string | number | boolean | null>,
  ok = true,
): void {
  const trace = current;
  if (!trace) return;
  if (trace.spans.length >= MAX_SPANS) return;
  trace.spans.push({
    name,
    startOffsetMs: Math.round(now() - trace.startedAt),
    durationMs: Math.round(durationMs),
    ok,
    attributes,
  });
}

/** Attach a fact to the whole trace (document type, copies, transport…). */
export function annotateTrace(
  attributes: Record<string, string | number | boolean | null>,
): void {
  if (!current) return;
  Object.assign(current.attributes, attributes);
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
 * Traces do not nest: a nested call joins the outer trace so a reprint
 * triggered from inside a print still produces one waterfall.
 */
export async function withTrace<T>(
  input: { label: string; correlationId?: string; attributes?: Record<string, string | number | boolean | null> },
  fn: (ctx: TraceContext) => Promise<T>,
): Promise<T> {
  if (current) return await fn(current);

  const trace: TraceContext = {
    correlationId: input.correlationId ?? newCorrelationId(),
    label: input.label,
    startedAt: now(),
    spans: [],
    attributes: { ...(input.attributes ?? {}) },
  };
  current = trace;
  try {
    return await fn(trace);
  } finally {
    current = null;
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
    await supabase.from('print_traces' as never).insert({
      correlation_id: trace.correlationId,
      label: trace.label,
      total_ms: totalMs,
      spans: trace.spans,
      attributes: trace.attributes,
    } as never);
  } catch { /* telemetry never blocks or throws */ }
}
