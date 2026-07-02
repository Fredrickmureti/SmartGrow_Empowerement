import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard:
 *
 * `sms_event_outbox.status` has a CHECK constraint allowing only:
 *   queued | processing | sent | failed | skipped
 *
 * Migration 20260430073349 introduced `enqueue_inventory_sms()` that inserted
 * `status='pending'`. The INSERT silently failed against the CHECK constraint,
 * and the caller swallowed the error with `EXCEPTION WHEN OTHERS THEN NULL`,
 * so low_stock and out_of_stock SMS messages were never queued.
 *
 * Migration 20260430082622 fixes this. This test ensures no future migration
 * reintroduces the bug by inserting a disallowed status into sms_event_outbox.
 */
const ALLOWED = new Set(["queued", "processing", "sent", "failed", "skipped"]);

// Migrations that are historical and known-broken; the fix migration supersedes them.
const HISTORICAL_BROKEN = new Set([
  "20260430073349_928574bb-0923-456d-9fa8-7dd630708482.sql",
  "20260430075527_8884007c-f64d-4c51-a305-9eff472601aa.sql",
]);

function stripSqlComments(sql: string): string {
  // Remove block comments /* ... */ and line comments -- ...
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*\n/g, "\n");
}

describe("sms_event_outbox status values in migrations", () => {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));

  for (const file of files) {
    if (HISTORICAL_BROKEN.has(file)) continue;
    const raw = readFileSync(join(dir, file), "utf8");
    if (!/sms_event_outbox/i.test(raw)) continue;
    const sql = stripSqlComments(raw);
    if (!/sms_event_outbox/i.test(sql)) continue;

    it(`migration ${file} only inserts allowed status values into sms_event_outbox`, () => {
      // Find every INSERT INTO ... sms_event_outbox ( ... ) VALUES ( ... ) block,
      // including PL/pgSQL function bodies. Then look for status literals.
      // We approximate by scanning windows around each sms_event_outbox occurrence.
      const occurrences: string[] = [];
      const re = /sms_event_outbox[\s\S]{0,1200}?\)\s*;/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        occurrences.push(m[0]);
      }

      for (const block of occurrences) {
        // Pull every quoted literal in the block.
        const literals = block.match(/'([a-zA-Z_]+)'/g) || [];
        for (const lit of literals) {
          const v = lit.replace(/'/g, "").toLowerCase();
          // Only validate tokens that look like a status enum value.
          if (
            v === "pending" ||
            v === "queued" ||
            v === "processing" ||
            v === "sent" ||
            v === "failed" ||
            v === "skipped"
          ) {
            expect(
              ALLOWED.has(v),
              `Migration ${file} contains disallowed sms_event_outbox.status='${v}' (allowed: ${[...ALLOWED].join(", ")})`,
            ).toBe(true);
          }
        }
      }
    });
  }
});
