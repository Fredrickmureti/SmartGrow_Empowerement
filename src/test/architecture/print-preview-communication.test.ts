/**
 * Architecture invariant: every sales / finance / purchases page that mounts
 * PrintPreviewDialog must pass a `communication` prop so the SMS / Email
 * action bar appears in the document preview.
 *
 * Pages that render PrintPreviewDialog purely for *report* output (no contact
 * recipient) are exempt and listed in EXEMPT_FILES.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOTS = ["src/pages", "src/components/invoices", "src/components/pos"];

const EXEMPT_FILES = new Set<string>([
  // Report exports / shift reports — no per-contact communication
  "src/components/pos/ShiftReportDialog.tsx",
  "src/services/reports/ReportExportService.ts",
  "src/components/reports/ReportExportButtons.tsx",
  "src/components/reports/PrintPreviewDialog.tsx", // separate report-specific dialog
  "src/components/common/PrintPreviewDialog.tsx",  // the dialog itself
  // RecordPaymentDialog reuses the dialog but the parent page already passes
  // communication when previewing the resulting receipt.
  "src/components/invoices/RecordPaymentDialog.tsx",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("PrintPreviewDialog communication prop", () => {
  it("every sales/finance/purchases caller passes `communication=`", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (EXEMPT_FILES.has(file)) continue;
        const src = readFileSync(file, "utf8");
        if (!/\bPrintPreviewDialog\b/.test(src)) continue;
        // Any rendering of <PrintPreviewDialog ... > must include communication=
        const renders = src.match(/<PrintPreviewDialog\b[\s\S]*?\/>|<PrintPreviewDialog\b[\s\S]*?>[\s\S]*?<\/PrintPreviewDialog>/g) || [];
        for (const r of renders) {
          if (!/\bcommunication\s*=/.test(r)) {
            offenders.push(`${file}: PrintPreviewDialog rendered without \`communication=\``);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
