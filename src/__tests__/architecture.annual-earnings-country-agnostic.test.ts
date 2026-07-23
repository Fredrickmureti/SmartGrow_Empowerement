/**
 * Architecture guard — the base Annual Earnings Statement (ADR-0063)
 * must remain country-neutral. Country-specific tokens (P9, P60, IRP5,
 * PAYE, NHIF, NSSF, SHIF, SSNIT, KRA, HMRC, SARS…) may live only inside
 * localization pack code paths, never in the shared resolver, edge
 * function dispatcher, or ESS page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FORBIDDEN = /\b(P9|P9A|P60|IRP5|SSNIT|KRA|HMRC|SARS|PAYE|NHIF|NSSF|SHIF|AHL|NITA|SDL)\b/i;

const FILES = [
  "supabase/functions/_shared/annualEarningsTypes.ts",
  "supabase/functions/_shared/annualEarningsResolver.ts",
  "supabase/functions/generate-annual-earnings-statement/index.ts",
  "src/pages/me/MyAnnualEarnings.tsx",
  "supabase/functions/_shared/certificateSourceResolver.ts",
];

describe("annual-earnings country agnosticism", () => {
  for (const rel of FILES) {
    it(`${rel} contains no country-specific tokens`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      // Strip line/block comments so ADR references in prose don't trip the guard.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\n)\s*\*.*(?=\n)/g, "")
        .replace(/(^|\n)\s*\/\/.*(?=\n)/g, "");
      const m = code.match(FORBIDDEN);
      expect(m, `country token '${m?.[0]}' leaked into ${rel}`).toBeNull();
    });
  }
});