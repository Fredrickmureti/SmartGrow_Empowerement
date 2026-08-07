/**
 * Phase 3 — one accounting kernel, two hosts.
 *
 * The browser renders a financial statement from
 * `src/services/reports/*`; `render-report` renders the archived PDF of the
 * same statement from `supabase/functions/_shared/reportDataEngine.ts`. For
 * years each side carried its own copy of the accounting primitives, and
 * they had already drifted (equity `>= 3200` on the server vs `3200..3999`
 * in the browser) — a silent screen-vs-PDF mismatch waiting for the right
 * chart of accounts.
 *
 * Both sides now bind to
 * `supabase/functions/_shared/reports/accountingKernel.ts`. These guards
 * keep it that way:
 *
 *  1. Neither host re-declares a kernel primitive.
 *  2. The server's detail-type projection agrees with the browser's
 *     authoritative detail-type table for every mapped detail type.
 *  3. Client and server classification return the same sub-type across the
 *     whole code-range space and every known detail type.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyAccount as clientClassify } from "@/services/reports/AccountClassification";
import { DETAIL_TYPE_CLASSIFICATION } from "@/lib/accountDetailTypeClassification";
import {
  classifyAccountSubType as serverClassify,
  DETAIL_TYPE_TO_SUB_TYPE,
} from "../../../supabase/functions/_shared/reportDataEngine";
import {
  calculateBalance,
  isDebitNormal,
} from "../../../supabase/functions/_shared/reports/accountingKernel";

const ROOT = process.cwd();
const KERNEL_REL = "supabase/functions/_shared/reports/accountingKernel.ts";

const HOSTS = [
  "src/services/reports/ReportCalculationEngine.ts",
  "src/services/reports/AccountClassification.ts",
  "supabase/functions/_shared/reportDataEngine.ts",
];

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;

describe("accounting kernel is the single definition", () => {
  it("both hosts import the kernel", () => {
    for (const host of HOSTS) {
      expect(read(host), `${host} must bind to the shared accounting kernel`).toMatch(
        /reports\/accountingKernel/,
      );
    }
  });

  it("no host re-declares a kernel primitive", () => {
    const primitives = [
      "isDebitNormal",
      "calculateBalance",
      "extractCodeNumber",
      "SUB_TYPE_LABELS",
      "BS_ASSET_ORDER",
      "BS_LIABILITY_ORDER",
      "BS_EQUITY_ORDER",
      "PNL_INCOME_ORDER",
      "PNL_EXPENSE_ORDER",
      "ACCOUNT_TYPE_ORDER",
      "ACCOUNT_TYPE_LABELS",
    ];
    const offenders: string[] = [];
    for (const host of HOSTS) {
      const src = read(host);
      for (const name of primitives) {
        const declared = new RegExp(
          `^(?:export )?(?:const|function)\\s+${name}\\b`,
          "m",
        ).test(src);
        if (declared) offenders.push(`${host} re-declares ${name}`);
      }
    }
    expect(offenders, `Import it from ${KERNEL_REL} instead`).toEqual([]);
  });

  it("keeps the accounting sign convention", () => {
    expect(isDebitNormal("asset")).toBe(true);
    expect(isDebitNormal("expense")).toBe(true);
    expect(isDebitNormal("liability")).toBe(false);
    expect(calculateBalance("asset", 100, 40, 10)).toBe(130);
    expect(calculateBalance("liability", 100, 40, 10)).toBe(70);
  });
});

describe("client and server classify accounts identically", () => {
  it("the server detail-type projection matches the browser table", () => {
    const mismatches: string[] = [];
    for (const [detailType, spec] of Object.entries(DETAIL_TYPE_CLASSIFICATION)) {
      const serverSubType = DETAIL_TYPE_TO_SUB_TYPE[detailType];
      if (!serverSubType) {
        mismatches.push(`${detailType}: missing from the server projection`);
      } else if (serverSubType !== spec.subType) {
        mismatches.push(
          `${detailType}: server "${serverSubType}" vs client "${spec.subType}"`,
        );
      }
    }
    expect(
      mismatches,
      "supabase/functions/_shared/reportDataEngine.ts#DETAIL_TYPE_TO_SUB_TYPE must mirror " +
        "src/lib/accountDetailTypeClassification.ts#DETAIL_TYPE_CLASSIFICATION",
    ).toEqual([]);
  });

  it("the server projection invents no detail types the browser does not know", () => {
    const extra = Object.keys(DETAIL_TYPE_TO_SUB_TYPE).filter(
      (dt) => !DETAIL_TYPE_CLASSIFICATION[dt],
    );
    expect(extra).toEqual([]);
  });

  it("agrees across the whole code-range space", () => {
    const mismatches: string[] = [];
    for (const accountType of ACCOUNT_TYPES) {
      for (let code = 1000; code < 10000; code += 25) {
        const c = clientClassify(accountType, String(code));
        const s = serverClassify(accountType, String(code), null);
        if (c !== s) mismatches.push(`${accountType} ${code}: client ${c} vs server ${s}`);
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it("agrees for every known detail type", () => {
    const mismatches: string[] = [];
    for (const detailType of Object.keys(DETAIL_TYPE_CLASSIFICATION)) {
      for (const accountType of ACCOUNT_TYPES) {
        const c = clientClassify(accountType, "9999", detailType);
        const s = serverClassify(accountType, "9999", detailType);
        if (c !== s) {
          mismatches.push(`${detailType}/${accountType}: client ${c} vs server ${s}`);
        }
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });
});
