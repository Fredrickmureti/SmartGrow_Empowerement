/**
 * Architecture guard — outbound email From-line identity.
 *
 * Only the centralized transport (`supabase/functions/send-email`) and the
 * explicitly platform-scoped senders may read `resend_from_name` directly.
 * Every other edge function MUST route through `send-email` (which calls
 * `resolveSenderIdentity` to pick the tenant's business identity).
 *
 * In addition, every caller of `send-email` MUST pass either `category` or
 * `organization_id` so the resolver can pick a tenant From-line instead of
 * silently falling back to the platform default. See ADR 0023.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "supabase/functions";
const ALLOWLIST = new Set([
  "send-email", // the transport itself
  "send-admin-email", // platform → admin
  "send-platform-email", // platform → tenant admin chrome
  "send-contact-message", // platform contact form
  "submit-demo-request", // public landing-page → platform marketing inbox
  "_shared", // shared modules
]);

/** Callers of send-email that are intentionally exempt from the tenant-context
 *  rule (e.g. platform-scoped admin chrome that already lives on the platform
 *  identity path).
 */
const INVOKE_CONTEXT_EXEMPT = new Set<string>([
  // none today
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (e === "index.ts") out.push(p);
  }
  return out;
}

describe("architecture: tenant-facing email functions must not read resend_from_name directly", () => {
  it("no disallowed function reads platform_settings.resend_from_name", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const segs = file.split("/");
      const fnDir = segs[segs.length - 2];
      if (ALLOWLIST.has(fnDir)) continue;
      const src = readFileSync(file, "utf8");
      if (/resend_from_name/.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      "These functions must call supabase.functions.invoke('send-email', ...) " +
        "with organization_id/business_id instead of reading resend_from_name " +
        "directly. See docs/adr/0023-tenant-sender-identity-resolution.md.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

describe("architecture: send-email callers must pass tenant context", () => {
  // Match the start of each `supabase.functions.invoke("send-email", …)`
  // call, then walk forward balancing braces/parens to capture the entire
  // call expression. A naive non-greedy `([\s\S]*?)\}` would stop at the
  // first nested object literal (e.g. `metadata: { … }`) and miss the
  // outer `category` / `organization_id` keys.
  const INVOKE_START_RE =
    /(?:supabase|supa|client)\s*\.\s*functions\s*\.\s*invoke\(\s*["'`]send-email["'`]\s*,/g;
  const RAW_FETCH_RE =
    /fetch\(\s*[^)]*\/functions\/v1\/send-email[^)]*\)/g;

  function extractInvokeCalls(src: string): string[] {
    const calls: string[] = [];
    let m: RegExpExecArray | null;
    INVOKE_START_RE.lastIndex = 0;
    while ((m = INVOKE_START_RE.exec(src))) {
      // Find the matching outer ')' for the invoke(...) call.
      let depth = 1; // we are inside the outer `(` of invoke(
      let i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === '"' || ch === "'" || ch === "`") {
          // skip string literal
          const quote = ch;
          i++;
          while (i < src.length && src[i] !== quote) {
            if (src[i] === "\\") i++;
            i++;
          }
        }
        i++;
      }
      calls.push(src.slice(m.index, i));
    }
    return calls;
  }

  it("every invoke('send-email', ...) body carries category or organization_id", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const segs = file.split("/");
      const fnDir = segs[segs.length - 2];
      if (fnDir === "send-email" || fnDir === "_shared") continue;
      if (INVOKE_CONTEXT_EXEMPT.has(fnDir)) continue;

      const src = readFileSync(file, "utf8");
      for (const callSrc of extractInvokeCalls(src)) {
        if (
          !/\bcategory\b/.test(callSrc) &&
          !/\borganization_id\b/.test(callSrc)
        ) {
          offenders.push(`${file} :: invoke('send-email') missing category/organization_id`);
        }
      }

      // Raw service-role fetches into /functions/v1/send-email cannot be
      // statically inspected for the body shape — flag them outright so the
      // author either switches to supabase.functions.invoke (preferred) or
      // explicitly opts in via INVOKE_CONTEXT_EXEMPT with a comment.
      RAW_FETCH_RE.lastIndex = 0;
      if (RAW_FETCH_RE.test(src)) {
        offenders.push(`${file} :: raw fetch('/functions/v1/send-email') — use supabase.functions.invoke and pass category/organization_id`);
      }
    }
    expect(
      offenders,
      "These send-email call sites do not pass tenant context, so the " +
        "From-line silently falls back to the platform name. Add `category` " +
        "and `organization_id` to the invoke body. See ADR 0023.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
