/**
 * Architecture guard (CRM Phase 2): lifecycle state on `crm_leads` is owned by
 * the database transition RPCs (`crm_qualify_lead`, `crm_change_stage`,
 * `crm_mark_won`, `crm_mark_lost`, `crm_reopen_lead`, `crm_reassign_lead`,
 * `crm_revalue_lead`, `crm_archive_lead`).
 *
 * The browser may still edit descriptive fields (name, notes, tags, source),
 * but it may never write `status`, `stage_id`, `won_at`, `lost_at`,
 * `probability`, `is_active`, `type`, `assigned_to`, `lost_reason_id` or
 * `expected_revenue` on `crm_leads` through a direct `.update()`. Those writes
 * are refused by `_crm_lead_lifecycle_write_guard`; this test stops them being
 * re-introduced in the client where they would only fail at runtime.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");

const GUARDED_FIELDS = [
  "status",
  "stage_id",
  "won_at",
  "lost_at",
  "probability",
  "is_active",
  "type",
  "assigned_to",
  "lost_reason_id",
  "expected_revenue",
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("crm: lead lifecycle is RPC-only", () => {
  it("no client file writes a guarded lifecycle column on crm_leads", () => {
    const files = walk(ROOT).filter((f) => !/\.test\.(ts|tsx)$/.test(f));
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Find each `.from("crm_leads")` chain and inspect the ~400 chars that
      // follow — enough to cover the `.update({ ... })` payload.
      const re = /\.from\(\s*["'`]crm_leads["'`]\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const chunk = src.slice(m.index, m.index + 400);
        if (!/\.update\(/.test(chunk)) continue;
        const hit = GUARDED_FIELDS.find((f) =>
          new RegExp(`["'\`]?${f}["'\`]?\\s*:`).test(chunk)
        );
        if (hit) offenders.push(`${relative(process.cwd(), file)} → ${hit}`);
      }
    }

    expect(
      offenders,
      `Use the crm_* transition RPCs instead of a direct update:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("useLeads exposes the authoritative transition operations", () => {
    const src = readFileSync(join(ROOT, "hooks/crm/useLeads.ts"), "utf8");
    for (const rpc of [
      "crm_qualify_lead",
      "crm_change_stage",
      "crm_mark_won",
      "crm_mark_lost",
      "crm_reopen_lead",
      "crm_reassign_lead",
      "crm_revalue_lead",
      "crm_archive_lead",
    ]) {
      expect(src, `useLeads.ts must call ${rpc}`).toContain(rpc);
    }
  });
});
