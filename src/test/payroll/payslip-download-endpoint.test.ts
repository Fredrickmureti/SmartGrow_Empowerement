import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../services/payroll/payslipDocuments.ts", import.meta.url),
  "utf8",
);

describe("payslip browser downloads", () => {
  it("use the deployed PDF function and never call the optional ensure endpoint", () => {
    const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(executableSource).toContain("functions.invoke('generate-payslip-pdf'");
    expect(executableSource).not.toContain("functions.invoke('ensure-payslip-document'");
    expect(executableSource).not.toContain("invokeEnsure('ensure-payslip-document'");
  });
});