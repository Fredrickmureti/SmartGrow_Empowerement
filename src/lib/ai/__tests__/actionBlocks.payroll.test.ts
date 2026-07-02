import { describe, it, expect } from "vitest";
import { parseAssistantContent } from "../actionBlocks";

describe("actionBlocks — fix_gl_mappings with payroll_run_id", () => {
  it("preserves payroll_run_id when valid", () => {
    const input = [
      "You have a blocked run.",
      `::action {"type":"fix_gl_mappings","label":"Fix mappings for PAY-0001","payroll_run_id":"186aae99-0000-4000-8000-000000000000"}`,
    ].join("\n");
    const { actions } = parseAssistantContent(input);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "fix_gl_mappings",
      label: "Fix mappings for PAY-0001",
      payroll_run_id: "186aae99-0000-4000-8000-000000000000",
    });
  });

  it("omits payroll_run_id when not provided", () => {
    const input = `::action {"type":"fix_gl_mappings","label":"Fix payroll mappings now"}`;
    const { actions } = parseAssistantContent(input);
    expect(actions).toEqual([{ type: "fix_gl_mappings", label: "Fix payroll mappings now" }]);
  });

  it("ignores empty-string payroll_run_id", () => {
    const input = `::action {"type":"fix_gl_mappings","label":"Fix","payroll_run_id":""}`;
    const { actions } = parseAssistantContent(input);
    expect(actions[0]).not.toHaveProperty("payroll_run_id");
  });
});
