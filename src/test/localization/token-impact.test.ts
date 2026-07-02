import { describe, it, expect } from "vitest";
import {
  tokenReferencesRow,
  templateReferencesRow,
} from "@/features/localization/lib/tokenImpact";
import { classifyTokens } from "@/features/localization/components/TokenAwareTextarea";

describe("tokenReferencesRow", () => {
  it("matches tax tokens by prefix and template marker", () => {
    expect(tokenReferencesRow("tax.vat.rate", "tax", "vat")).toBe(true);
    expect(tokenReferencesRow("tax.vat", "tax", "vat")).toBe(true);
    expect(tokenReferencesRow("tax_template:vat", "tax", "vat")).toBe(true);
    expect(tokenReferencesRow("tax.gst.rate", "tax", "vat")).toBe(false);
  });

  it("matches account tokens via account.* and gl.* prefixes", () => {
    expect(tokenReferencesRow("account.2100.balance", "account", "2100")).toBe(true);
    expect(tokenReferencesRow("gl.2100.debit", "account", "2100")).toBe(true);
    expect(tokenReferencesRow("account.2200.balance", "account", "2100")).toBe(false);
  });

  it("matches remittance tokens by rule_code", () => {
    expect(tokenReferencesRow("remittance.kra_paye.due", "remittance", "kra_paye")).toBe(true);
    expect(tokenReferencesRow("remittance.nssf.due", "remittance", "kra_paye")).toBe(false);
  });

  it("returns false for empty key", () => {
    expect(tokenReferencesRow("tax.vat.rate", "tax", "")).toBe(false);
  });
});

describe("templateReferencesRow", () => {
  it("scans nested template bodies and returns matched tokens", () => {
    const body = {
      header: "Invoice",
      blocks: [
        { content: "VAT: {{tax.vat.rate}}%" },
        { content: "Total to {{account.2100.balance}}" },
        { content: "Unrelated {{employee.name}}" },
      ],
    };
    expect(templateReferencesRow(body, "tax", "vat")).toEqual(["tax.vat.rate"]);
    expect(templateReferencesRow(body, "account", "2100")).toEqual(["account.2100.balance"]);
    expect(templateReferencesRow(body, "tax", "gst")).toEqual([]);
  });
});

describe("classifyTokens", () => {
  const registry = new Set(["employee.name", "tax.vat.rate"]);

  it("flags registered, unknown, and malformed tokens", () => {
    const out = classifyTokens(
      "Hello {{employee.name}}, VAT {{tax.vat.rate}}, oops {{employee name}}, also {{tax.gst.rate}}",
      registry,
    );
    const byStatus = out.reduce<Record<string, string[]>>((acc, c) => {
      (acc[c.status] ??= []).push(c.raw);
      return acc;
    }, {});
    expect(byStatus.registered).toEqual(["{{employee.name}}", "{{tax.vat.rate}}"]);
    expect(byStatus.unknown).toEqual(["{{tax.gst.rate}}"]);
    expect(byStatus.malformed).toEqual(["{{employee name}}"]);
  });

  it("returns empty array when no tokens present", () => {
    expect(classifyTokens("Plain text only", registry)).toEqual([]);
  });
});
