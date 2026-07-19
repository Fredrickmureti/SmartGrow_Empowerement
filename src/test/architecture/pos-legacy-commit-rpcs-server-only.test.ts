/**
 * Architecture guard — Wave 3 · Phase 4.f (POS Payment Engine)
 *
 * `process_pos_transaction` and `finalize_table_order` are now
 * server-internal forwardees of `pos_payment_session_commit`. No client
 * module may call them by name via `supabase.rpc(...)` — every commit
 * MUST flow through `paymentSessionClient.commitSession`.
 *
 * The test scans the shipped source tree. It intentionally fails the
 * build if a future edit re-introduces a direct client call.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");

const LEGACY_RPCS = [
  "process_pos_transaction",
  "finalize_table_order",
] as const;

/**
 * Files allowed to reference the legacy RPC names for documentation,
 * type shims, or test fixtures. Nothing under this list may call them
 * via `supabase.rpc(...)`; the string appearance is fine here because
 * this test file itself would otherwise be an offender.
 */
const ALLOWLIST = [
  /^test[\\/]/,
  /^__tests__[\\/]/,
  /\.test\.ts$/,
  /\.test\.tsx$/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("POS legacy commit RPCs are server-only", () => {
  const files = walk(ROOT);

  it("no client module calls process_pos_transaction or finalize_table_order via supabase.rpc", () => {
    const offenders: Array<{ file: string; rpc: string }> = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (ALLOWLIST.some((r) => r.test(rel))) continue;
      const src = readFileSync(file, "utf8");
      for (const rpc of LEGACY_RPCS) {
        // Match `.rpc("rpc_name"` or `.rpc('rpc_name'` (with optional
        // `as any` / whitespace between .rpc and the paren).
        const re = new RegExp(String.raw`\.rpc\s*\(\s*["']${rpc}["']`);
        if (re.test(src)) {
          offenders.push({ file: rel, rpc });
        }
      }
    }
    expect(
      offenders,
      `Legacy commit RPCs must be called via paymentSessionClient.commitSession.\nOffenders:\n${offenders
        .map((o) => `  ${o.file} → ${o.rpc}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
