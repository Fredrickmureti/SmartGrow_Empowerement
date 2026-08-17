/**
 * Architecture guard — cycle count integrity seams.
 *
 * Three invariants established by ADR 0106:
 *
 * 1. Count lines are read through `get_count_lines`, never off
 *    `wms_count_lines` directly. The RPC is what masks the expected
 *    quantity during a blind count; a direct table read would hand the
 *    counter the answer and silently destroy the control.
 * 2. No surface writes `counted_qty` / `variance_qty` / stock. Capture
 *    goes through `record_count`, posting through `post_count_session`.
 * 3. The warehouse never posts the adjustment itself — the count session
 *    hands off to the canonical Inventory count document.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/pages/warehouse", "src/pages/warehouse-mobile", "src/features/warehouse"];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => {
  try {
    return walk(join(process.cwd(), r));
  } catch {
    return [];
  }
});

/** The single sanctioned read seam is allowed to be the exception. */
const READ_SEAM = "features/warehouse/counts/useCountLines.ts";

describe("cycle count seams", () => {
  it("no surface selects from wms_count_lines directly", () => {
    const offenders = FILES.filter((f) => {
      if (f.replace(/\\/g, "/").endsWith(READ_SEAM)) return false;
      const src = readFileSync(f, "utf8");
      return /\.from\(\s*["'`]wms_count_lines["'`]\s*\)/.test(src);
    });
    expect(
      offenders,
      `Read count lines through get_count_lines (useCountLines) so blind counts stay blind:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no surface updates or inserts count lines", () => {
    const offenders = FILES.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /wms_count_lines["'`]\s*\)\s*\.\s*(update|insert|upsert|delete)/.test(src);
    });
    expect(
      offenders,
      `Count capture must go through record_count:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no count surface posts stock adjustments itself", () => {
    const countFiles = FILES.filter((f) => /count/i.test(f));
    const offenders = countFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return (
        /approve_stock_adjustment_atomic|physical_count_approve/.test(src) ||
        /\.from\(\s*["'`]stock_quants["'`]\s*\)\s*\.\s*(update|insert|upsert|delete)/.test(src)
      );
    });
    expect(
      offenders,
      `Warehouse hands counts to Inventory via post_count_session; it never posts stock itself:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });


  it("the review screen collects a reason code for every difference", () => {
    const src = readFileSync(join(process.cwd(), "src/pages/warehouse/CountReview.tsx"), "utf8");
    expect(src).toMatch(/VARIANCE_REASONS/);
    expect(src).toMatch(/missingReasons/);
    // Submission is blocked while any difference has no reason.
    expect(src).toMatch(/missingReasons\.length === 0/);
  });

  it("the counting screens honour blind mode", () => {
    for (const page of ["src/pages/warehouse/CountSession.tsx", "src/pages/warehouse-mobile/MobileCount.tsx"]) {
      const src = readFileSync(join(process.cwd(), page), "utf8");
      expect(src, `${page} must branch on blind mode`).toMatch(/blind/i);
      expect(src, `${page} must use the sanctioned read seam`).toMatch(/useCountLines/);
    }
  });

  // Invariant 4 (Phase 7) — count work closes on evidence, not on a click.
  it("the operator queue never hand-completes a count task", () => {
    const src = readFileSync(join(process.cwd(), "src/pages/warehouse/OperatorTasks.tsx"), "utf8");
    expect(src, "count tasks must route to their session").toMatch(/task_type === "count"/);
    expect(src, "count tasks must deep-link to the count session").toMatch(/counts\/\$\{t\.source_doc_id\}/);
  });

  it("event-triggered count rules have an admin surface", () => {
    const src = readFileSync(join(process.cwd(), "src/pages/warehouse/CountTriggers.tsx"), "utf8");
    expect(src).toMatch(/wms_count_triggers/);
    expect(src).toMatch(/cooldown_hours/);
  });

  // Invariant 5 (governance audit) — a resolved count never reads as pending,
  // and no surface re-derives "awaiting approval" from the capture-time flag.
  it("pending approval is derived from the resolution, not the capture flag", () => {
    const seam = readFileSync(
      join(process.cwd(), "src/features/warehouse/counts/useCountLines.ts"),
      "utf8",
    );
    expect(seam, "the read seam must expose the resolution").toMatch(/approval_state/);
    expect(seam, "one predicate owns 'still awaiting approval'").toMatch(
      /export function countLineAwaitsApproval/,
    );

    const offenders = FILES.filter((f) => {
      if (f.replace(/\\/g, "/").endsWith(READ_SEAM)) return false;
      const src = readFileSync(f, "utf8");
      // Comparing the capture-time flag to approval_required, without consulting
      // the resolution, is what made a posted count keep asking for a supervisor.
      return (
        /tolerance_outcome\s*===\s*["'`]approval_required["'`]/.test(src) &&
        !/approval_state/.test(src)
      );
    });
    expect(
      offenders,
      `Use countLineAwaitsApproval — a posted, approved count is not pending:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the count PDF prints recorded sign-offs rather than blank rules", () => {
    const layout = readFileSync(
      join(process.cwd(), "supabase/functions/_shared/pdf/layouts/warehouseCount.ts"),
      "utf8",
    );
    expect(layout, "signature slots come from the snapshot").toMatch(/function signatureSlots/);
    expect(layout).toMatch(/signoffs/);

    const snapshot = readFileSync(
      join(process.cwd(), "src/services/documents/snapshots/wmsCount.ts"),
      "utf8",
    );
    expect(snapshot, "sign-offs are resolved server-side, never guessed").toMatch(
      /get_count_signoffs/,
    );
  });
});


