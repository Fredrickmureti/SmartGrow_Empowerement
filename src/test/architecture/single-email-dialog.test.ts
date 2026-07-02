/**
 * Architecture guard — unified document email dialog.
 *
 * All user-composed document email MUST go through
 * `src/components/common/SendDocumentDialog.tsx`, which embeds the
 * AIEmailAssistant. Per-document dialogs (ReceiptEmailDialog,
 * PayslipEmailDialog, etc.) and direct invocations of the legacy
 * `send-receipt-email` edge function are forbidden — they cause the
 * AI-assistant divergence we just unified away.
 *
 * Allowlisted:
 *  - SendDocumentDialog itself (the canonical dialog)
 *  - EmailReportDialog (reports export — different surface, no doc id)
 *  - notification-only edge functions (send-leave-email, send-stock-alert-email,
 *    send-notification-email) — those are system-triggered, not user-composed.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const ALLOWLIST_DIALOGS = new Set([
  "src/components/common/SendDocumentDialog.tsx",
  "src/components/reports/EmailReportDialog.tsx",
]);

describe("single email dialog invariant", () => {
  it("no per-document email dialog components other than SendDocumentDialog/EmailReportDialog", () => {
    const out = execSync(
      "rg -l --glob '!src/test/**' " +
        "'(ReceiptEmailDialog|PayslipEmailDialog|InvoiceEmailDialog|BillEmailDialog)' src || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((p) => !ALLOWLIST_DIALOGS.has(p));
    expect(out, `Per-document email dialogs leaked back in:\n${out.join("\n")}`).toEqual([]);
  });

  it("no frontend caller invokes the deprecated send-receipt-email edge function", () => {
    const out = execSync(
      "rg -l --glob '!src/test/**' \"send-receipt-email\" src || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(out, `Reintroduced send-receipt-email caller:\n${out.join("\n")}`).toEqual([]);
  });

  it("the deprecated send-receipt-email edge function source is removed", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    expect(
      fs.existsSync("supabase/functions/send-receipt-email/index.ts"),
      "supabase/functions/send-receipt-email must stay deleted (replaced by send-document-email)",
    ).toBe(false);
  });

  it("the dead ReceiptDialog inline email form stays removed", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    expect(
      fs.existsSync("src/components/payments/ReceiptDialog.tsx"),
      "src/components/payments/ReceiptDialog.tsx must stay deleted — it bypassed SendDocumentDialog (no AI assistant, no tenant sender-identity resolution per ADR 0023). Use SendDocumentDialog instead.",
    ).toBe(false);
  });

  it("no component builds a tenant-document email inline via supabase.functions.invoke('send-email', …)", () => {
    // Defense-in-depth: a per-document dialog with its own HTML body builder
    // and base64 PDF attachments must not reappear (the dead ReceiptDialog
    // pattern). User-composed document email goes through SendDocumentDialog
    // → send-document-email. send-email is reserved for system notifications
    // and admin/platform broadcasts (allowlisted below).
    const ALLOWLIST_INVOKERS = new Set([
      "src/components/admin/email/ComposeEmailDialog.tsx",
      "src/components/admin/email/ComposeEmailTab.tsx",
    ]);
    const out = execSync(
      "rg -l --glob 'src/components/**' " +
        "\"supabase\\.functions\\.invoke\\(['\\\"]send-email['\\\"]\" src || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((p) => !ALLOWLIST_INVOKERS.has(p));
    expect(
      out,
      `Inline send-email caller in components/ — route user-composed document email through SendDocumentDialog instead:\n${out.join("\n")}`,
    ).toEqual([]);
  });
});
