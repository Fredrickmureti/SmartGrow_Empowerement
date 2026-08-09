/**
 * Architecture guard — credit note provenance and server authority.
 *
 * A credit note must be able to prove, from the database, which invoice line
 * it reversed. The browser expresses intent; the server resolves the money and
 * enforces the ceiling. These checks are the ratchet against sliding back to
 * UI-only protection.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../");
const SRC = join(ROOT, "src");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

const appFiles = walk(SRC).filter(
  (f) => !f.includes("/test/") && !f.includes("__tests__") && !f.endsWith("types.ts"),
);
const rel = (f: string) => f.replace(`${ROOT}/`, "");

describe("credit note provenance guard", () => {
  it("no client writes credit note lines directly", () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\(\s*["']credit_note_items["']\s*\)\s*\.\s*(insert|update|delete|upsert)/.test(src);
    });
    expect(
      offenders.map(rel),
      "credit note lines are written only by create_credit_note_atomic / update_credit_note_atomic",
    ).toEqual([]);
  });

  it("no client writes credit note headers directly", () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\(\s*["']credit_notes["']\s*\)\s*\.\s*(insert|upsert)/.test(src);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("no client deletes or status-updates credit notes directly", () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\(\s*["']credit_notes["']\s*\)\s*\.\s*(delete|update)/.test(src);
    });
    expect(
      offenders.map(rel),
      "deletion and header mutation belong to delete_credit_note_atomic / update_credit_note_atomic",
    ).toEqual([]);
  });

  it("provenance is submitted, never stripped", () => {
    const createPage = readFileSync(
      join(SRC, "features/sales/credit-notes/CreditNoteCreatePage.tsx"),
      "utf8",
    );
    expect(createPage.includes("stripProvenance")).toBe(false);
    expect(createPage).toMatch(/invoice_item_id:\s*source_invoice_item_id/);
  });

  it("the creditable ceiling is read from the database view, not from invoiced quantity", () => {
    const hook = readFileSync(
      join(SRC, "features/sales/credit-notes/useInvoiceCreditableLines.ts"),
      "utf8",
    );
    expect(hook).toMatch(/v_invoice_creditable_qty/);

    const picker = readFileSync(
      join(SRC, "features/sales/credit-notes/InvoiceLineCreditPicker.tsx"),
      "utf8",
    );
    expect(
      picker.includes("Math.min(value, line.remaining_qty)"),
      "the picker caps at remaining creditable quantity",
    ).toBe(true);
    expect(picker.includes("line.invoiced_qty)"), "no cap on the raw invoiced quantity").toBe(false);
  });

  it("credit note creation carries an idempotency key", () => {
    const transport = readFileSync(join(SRC, "services/finance/createCreditNote.ts"), "utf8");
    expect(transport).toMatch(/client_request_id/);
    const hook = readFileSync(join(SRC, "hooks/useCreditNotes.ts"), "utf8");
    expect(hook).toMatch(/client_request_id/);
  });

  it("editing a credit note goes through the server writer", () => {
    const editPage = readFileSync(
      join(SRC, "features/sales/credit-notes/CreditNoteEditPage.tsx"),
      "utf8",
    );
    expect(editPage).toMatch(/updateCreditNoteAtomic/);
  });
});
