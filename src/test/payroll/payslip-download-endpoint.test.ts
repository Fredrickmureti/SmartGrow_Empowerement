import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/services/payroll/payslipDocuments.ts"),
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