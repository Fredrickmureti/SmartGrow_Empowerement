/**
 * D1 invariant — a certificate template body cannot be silently mutated in
 * seed migrations without publishing a matching `pack_versions` row.
 *
 * Prior to 2026.5.0 the KE P9 template body was rewritten in-place
 * (migration 20260706001915) with no corresponding version bump, so
 * `propose-localization-upgrades` had nothing to fan out and tenants
 * received the improved P9 layout silently — violating the brief's
 * "changes must arrive through the normal upgrade flow" rule.
 *
 * This test statically enforces the paired shape going forward:
 *   any migration that touches `localization_pack_certificate_templates`
 *   at a body level MUST either publish a new `pack_versions` row for the
 *   same pack in the same migration, or the migration filename must appear
 *   in the allow-list below (historical exceptions).
 *
 * The allow-list is intentionally short and requires review to grow.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";

// Historical migrations that shipped certificate body changes without a
// matching version bump. Do NOT add new entries — publish a pack_versions
// row alongside the body change instead.
const GRANDFATHERED = new Set<string>([
  // Original seed of the KE pack (v1.0.0) — body is the initial payload.
  "20260223091409_seed_kenya_localization_pack.sql",
  // Pre-versioning seed refresh of KE certificate templates.
  "20260510082513_92000ad3-6b83-42ea-a827-3142f7cbeeb8.sql",
  // ADR-0060 in-place refresh; superseded by data insert that publishes
  // 2026.5.0 and fans out upgrade proposals.
  "20260706001915_41e386c8-d216-438b-9bc5-9802b673c55d.sql",
  // ADR-0060 companion migration touching legacy body fields; superseded
  // by the 2026.5.0 data insert and its upgrade-proposal fan-out.
  "20260706013020_56b00809-ba37-4703-97c1-cc38cfff0b16.sql",
]);

describe("certificate template body changes require a pack version bump", () => {
  it("every non-grandfathered migration that writes a template body also publishes a pack_versions row", () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const offenders: string[] = [];
    for (const f of files) {
      if (GRANDFATHERED.has(f)) continue;
      const src = readFileSync(join(DIR, f), "utf8");

      // Cheap detector: the migration writes a certificate template body
      // if it references the table AND mentions the `body` column in an
      // INSERT / UPDATE / jsonb_build_object shape.
      const touchesBody =
        /localization_pack_certificate_templates/.test(src) &&
        /\bbody\b/.test(src) &&
        /(INSERT\s+INTO\s+public\.localization_pack_certificate_templates|UPDATE\s+public\.localization_pack_certificate_templates|ON\s+CONFLICT[\s\S]{0,200}\bbody\b)/i.test(
          src,
        );

      if (!touchesBody) continue;

      const publishesVersion =
        /INSERT\s+INTO\s+public\.pack_versions/i.test(src) &&
        /status\s*[,)]\s*['"]published['"]|['"]published['"]/i.test(src);

      if (!publishesVersion) offenders.push(f);
    }

    expect(
      offenders,
      "Migrations that change a certificate template body must publish a " +
        "matching pack_versions row in the same migration so that " +
        "propose-localization-upgrades can fan out upgrade proposals to " +
        "installed tenants. Offenders:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});