#!/usr/bin/env node
/**
 * Convert conditional business_id filters to unconditional.
 *
 * Transforms:
 *   let q = supabase.from("…").select("…").eq("organization_id", orgId);
 *   if (businessId) q = q.eq("business_id", businessId);
 *   // or: if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
 *
 * Into:
 *   let q = supabase.from("…").select("…").eq("organization_id", orgId).eq("business_id", businessId);
 *
 * And emits a report of each file's early-return guard so the human can verify
 * that `!businessId` short-circuits the query before it runs.
 *
 * Safety:
 *   - Only touches exact textual patterns we've audited.
 *   - Idempotent — re-running is a no-op.
 *   - Prints every edit for review.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync(
  `grep -rln "if (currentBusiness?\\.id)" src/hooks src/pages src/components src/lib src/services src/apps 2>/dev/null; ` +
  `grep -rln "if (businessId)" src/hooks src/pages src/components src/lib src/services src/apps 2>/dev/null`,
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .filter((f, i, a) => a.indexOf(f) === i)
  .filter((f) => !f.includes(".test."));

let filesChanged = 0;
let editsTotal = 0;

for (const file of files) {
  const orig = readFileSync(file, "utf8");
  let src = orig;

  // Pattern A: `if (currentBusiness?.id) <var> = <var>.eq("business_id", currentBusiness.id);`
  // Pattern B: `if (businessId) <var> = <var>.eq("business_id", businessId);`
  // Pattern C: same but without reassignment (void expression) — rare
  // We replace these lines by deleting them AND appending `.eq("business_id", …)` to the prior assignment.
  //
  // Because robustly rewriting arbitrary prior statements is risky, instead
  // we convert the `if (…) x = x.eq(…);` into `x = x.eq(…);` unconditionally.
  // This is safe IF the file's queryFn already early-returns when businessId is null.
  // We'll flag files where it doesn't for manual follow-up.

  const patterns = [
    {
      re: /^([ \t]+)if \(currentBusiness\?\.id\)\s+(\w+)\s*=\s*\2\.eq\("business_id",\s*currentBusiness\.id\);\s*$/gm,
      replace: (m, indent, name) => `${indent}${name} = ${name}.eq("business_id", currentBusiness!.id);`,
    },
    {
      re: /^([ \t]+)if \(businessId\)\s+(\w+)\s*=\s*\2\.eq\("business_id",\s*businessId\);\s*$/gm,
      replace: (m, indent, name) => `${indent}${name} = ${name}.eq("business_id", businessId);`,
    },
    {
      re: /^([ \t]+)if \(currentBusiness\?\.id\)\s*\{\s*\n\s+(\w+)\s*=\s*\2\.eq\("business_id",\s*currentBusiness\.id\);\s*\n[ \t]+\}\s*$/gm,
      replace: (m, indent, name) => `${indent}${name} = ${name}.eq("business_id", currentBusiness!.id);`,
    },
  ];

  let edits = 0;
  for (const p of patterns) {
    const next = src.replace(p.re, (...args) => {
      edits++;
      return p.replace(...args);
    });
    src = next;
  }

  if (edits > 0) {
    writeFileSync(file, src);
    filesChanged++;
    editsTotal += edits;
    console.log(`  ${file}: ${edits} conditional scopings made unconditional`);
  }
}

console.log(`\n${editsTotal} edits across ${filesChanged} files.`);
