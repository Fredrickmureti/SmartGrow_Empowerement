/**
 * Receipt engine mirror parity — Phase 1 diff-gate.
 *
 * The low-level receipt layout primitives (`ColumnLayout`, `PrinterProfile`)
 * exist in two physical locations today:
 *
 *   - src/lib/receipt/engine/*          → consumed by the Vite/React bundle
 *                                         (MonospacePreview, on-screen
 *                                          previews, customer display).
 *   - supabase/functions/_shared/receipt/engine/*
 *                                       → consumed by the Deno edge function
 *                                         (generate-document → thermal PDF,
 *                                          ESC/POS builder).
 *
 * They must be byte-identical. Receipt composition itself is no longer
 * mirrored: the browser adapter imports the canonical `lines.ts` producer.
 *
 * If this test fails, either:
 *   a) copy the intended canonical file over the mirror to re-sync, or
 *   b) update BOTH files with the intended change in the same commit.
 * Never edit only one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..");

const MIRRORS: Array<{ client: string; server: string; label: string }> = [
  {
    label: "ColumnLayout",
    client: "src/lib/receipt/engine/ColumnLayout.ts",
    server: "supabase/functions/_shared/receipt/engine/ColumnLayout.ts",
  },
  {
    label: "PrinterProfile",
    client: "src/lib/receipt/engine/PrinterProfile.ts",
    server: "supabase/functions/_shared/receipt/engine/PrinterProfile.ts",
  },
];

describe("Receipt engine mirror parity", () => {
  it("browser preview delegates to the canonical receipt row producer", () => {
    const clientSrc = readFileSync(
      join(root, "src/lib/receipt/preview/buildReceiptLines.ts"),
      "utf8",
    );
    expect(clientSrc).toContain("supabase/functions/_shared/receipt/lines");
    expect(clientSrc).toContain("buildCanonicalReceiptLines");
    expect(clientSrc).not.toContain("function fmtDateTime");
    expect(clientSrc).not.toContain("assembleItems");
  });

  for (const { client, server, label } of MIRRORS) {
    it(`${label}: client and server copies are byte-identical`, () => {
      const clientSrc = readFileSync(join(root, client), "utf8");
      const serverSrc = readFileSync(join(root, server), "utf8");
      expect(serverSrc, `${server} has drifted from ${client}`).toBe(clientSrc);
    });
  }
});
