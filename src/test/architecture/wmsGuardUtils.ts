/**
 * Shared helpers for the WMS architecture guards.
 *
 * Phase 2.4 §4 — guard reconciliation.
 *
 * Layering changed in Phase 2.4 §3: warehouse pages no longer call the
 * sanctioned domain RPCs directly. They call typed hooks in
 * `src/features/warehouse/aggregates/**`, and those hooks own the single
 * `supabase.rpc(...)` call site.
 *
 * The original intent of the phase guards ("this RPC is the ONLY write
 * path for this aggregate") is unchanged — only the layer that issues
 * the call moved. These helpers express that intent under the new
 * layering so the phase guards and `wms-no-direct-domain-rpc` can no
 * longer contradict one another.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const SRC = path.resolve(__dirname, "../..");
export const AGGREGATES_DIR = path.join(SRC, "features/warehouse/aggregates");

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Strip block and line comments so prose can't be mistaken for a call site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every file in the typed wrapper layer, concatenated, comments removed. */
export function wrapperLayerSource(): string {
  return walkTs(AGGREGATES_DIR)
    .map((f) => stripComments(readFileSync(f, "utf8")))
    .join("\n");
}


/** Source of a page under `src/pages/warehouse/`. */
export function pageSource(fileName: string): string {
  return readFileSync(path.join(SRC, "pages/warehouse", fileName), "utf8");
}

/** True when the RPC is invoked exactly once, from the wrapper layer. */
export function rpcCallSitesInWrapperLayer(rpc: string): number {
  const re = new RegExp(`supabase\\.rpc\\(\\s*["'\`]${rpc}["'\`]`, "g");
  return (wrapperLayerSource().match(re) ?? []).length;
}

/**
 * Assert that `rpc` is owned by the wrapper layer and that `page`
 * consumes it through `hook`.
 *
 * Returns a diagnostic string; empty string means "compliant".
 */
export function checkRpcOwnership(page: string, hook: string, rpc: string): string {
  const problems: string[] = [];
  const sites = rpcCallSitesInWrapperLayer(rpc);
  if (sites === 0) {
    problems.push(
      `RPC "${rpc}" has no call site in src/features/warehouse/aggregates/** — the wrapper layer must own it.`,
    );
  }
  if (sites > 1) {
    problems.push(
      `RPC "${rpc}" is called from ${sites} places in the wrapper layer — it must have exactly one call site.`,
    );
  }
  const src = pageSource(page);
  if (!new RegExp(`\\b${hook}\\s*\\(`).test(src)) {
    problems.push(`Page ${page} does not call the typed hook ${hook}().`);
  }
  if (!new RegExp(`from\\s+["'][^"']*aggregates[^"']*["']`).test(src)) {
    problems.push(`Page ${page} does not import from the aggregates wrapper layer.`);
  }
  return problems.join("\n");
}

/**
 * Legacy shape: the page still owns the call site directly (allowed for
 * RPCs that are not on the `wms-no-direct-domain-rpc` ban list).
 */
export function pageCallsRpc(page: string, rpc: string): boolean {
  return new RegExp(`rpc\\(\\s*["'\`]${rpc}["'\`]`).test(pageSource(page));
}
