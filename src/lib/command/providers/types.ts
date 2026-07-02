/**
 * Command Palette — Async Provider Interface
 *
 * Static command entries (apps, pages, actions, reports) are built once
 * at module load. Anything dynamic — record search across customers,
 * invoices, products, AI suggestions — plugs in here.
 *
 * Each provider runs independently, debounced, with abort support, and
 * its results are merged into the palette below the static results.
 * The static index is NEVER blocked on async work.
 */

import type { CommandEntry, CommandKind } from "../types";
import type { Permission } from "@/lib/permissions";

export interface ProviderContext {
  /** Currently active app id, useful for context-aware queries. */
  currentAppId: string | null;
  /** Abort signal — providers must respect this to avoid stale fetches. */
  signal: AbortSignal;
}

export interface CommandProvider {
  /** Stable id, e.g. "records:customers". */
  id: string;
  /** Human label used for the result group heading. */
  label: string;
  /** Skip until the query reaches this length. */
  minQueryLength: number;
  /** Per-provider debounce. Defaults to 150ms in the hook. */
  debounceMs?: number;
  /** Hard cap on returned entries (default 8). */
  limit?: number;
  /** Fetch matches for the given query. MUST honour `ctx.signal`. */
  fetch: (query: string, ctx: ProviderContext) => Promise<CommandEntry[]>;
  /**
   * Optional permission gate. If set, the provider is skipped when the
   * user does not hold this permission. Enforced in useCommandProviders.
   */
  permission?: Permission;
  /**
   * Optional kind affinity. When the user types a `#` prefix, only
   * providers whose results are this kind are kept. Defaults to "record".
   */
  kind?: CommandKind;
}
