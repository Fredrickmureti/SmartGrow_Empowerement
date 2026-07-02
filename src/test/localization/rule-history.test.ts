import { describe, it, expect } from "vitest";
import { traverseRuleHistory } from "@/features/localization/lib/ruleHistory";
import type { PackVersion } from "@/features/localization/hooks/usePack";

function v(over: Partial<PackVersion>): PackVersion {
  return {
    id: "v-" + Math.random().toString(36).slice(2, 8),
    pack_id: "p1",
    version: "1.0.0",
    status: "published",
    changelog: null,
    snapshot: null,
    parent_version_id: null,
    published_at: "2026-01-01T00:00:00Z",
    published_by: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by: null,
    ...over,
  };
}

const baseRule = (params: any, extra: any = {}) => ({
  rule_code: "PAYE",
  rule_type: "income_tax",
  parameters: params,
  ...extra,
});

describe("traverseRuleHistory", () => {
  it("returns empty when versions are missing or rule absent", () => {
    expect(traverseRuleHistory(undefined, "PAYE")).toEqual([]);
    expect(traverseRuleHistory([v({})], "PAYE")).toEqual([]);
    expect(
      traverseRuleHistory(
        [v({ snapshot: { localization_pack_payroll_templates: [baseRule({ rate: 0.1 })] } })],
        "",
      ),
    ).toEqual([]);
  });

  it("orders chronologically by published_at and filters out absent versions", () => {
    const versions: PackVersion[] = [
      v({
        id: "v3",
        version: "3.0.0",
        published_at: "2026-03-01T00:00:00Z",
        snapshot: { localization_pack_payroll_templates: [baseRule({ rate: 0.3 })] },
      }),
      v({
        id: "v1",
        version: "1.0.0",
        published_at: "2026-01-01T00:00:00Z",
        snapshot: { localization_pack_payroll_templates: [baseRule({ rate: 0.1 })] },
      }),
      v({
        id: "v2-no-rule",
        version: "2.0.0",
        published_at: "2026-02-01T00:00:00Z",
        snapshot: { localization_pack_payroll_templates: [{ rule_code: "OTHER", parameters: {} }] },
      }),
    ];
    const out = traverseRuleHistory(versions, "PAYE");
    expect(out.map((e) => e.version)).toEqual(["1.0.0", "3.0.0"]);
    expect(out[0].parameters).toEqual({ rate: 0.1 });
    expect(out[1].parameters).toEqual({ rate: 0.3 });
  });

  it("probes fallback snapshot tables and surfaces effective dates", () => {
    const versions: PackVersion[] = [
      v({
        id: "v1",
        version: "1.0.0",
        snapshot: {
          payroll_statutory_rules: [
            baseRule({ rate: 0.1 }, { effective_from: "2026-01-01", effective_to: "2026-06-30" }),
          ],
        },
      }),
      v({
        id: "v2",
        version: "2.0.0",
        published_at: "2026-07-01T00:00:00Z",
        // Custom table — exercises the fallback array scan.
        snapshot: { custom_table: [baseRule({ rate: 0.15 })] },
      }),
    ];
    const out = traverseRuleHistory(versions, "PAYE");
    expect(out).toHaveLength(2);
    expect(out[0].effective_from).toBe("2026-01-01");
    expect(out[0].effective_to).toBe("2026-06-30");
    expect(out[1].parameters).toEqual({ rate: 0.15 });
  });
});