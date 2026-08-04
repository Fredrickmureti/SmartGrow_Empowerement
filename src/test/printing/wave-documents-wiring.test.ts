/**
 * Source-inspection guard for wave paperwork (ADR-0112 Phase 5).
 *
 * Locks the same three properties the dispatch guard locks:
 *
 * 1. Both wave document types are registered in `FETCHER_MAP`,
 *    `TEMPLATE_TYPE_MAP` and `TABLE_MAP`, so `generate-document` resolves
 *    them and the entitlement lookup finds the owning wave.
 * 2. The tower REQUESTS documents through `printDocument` (ADR-0086) — no
 *    page invokes a render endpoint or chooses a transport.
 * 3. Rendering is a read model: the wave fetchers never plan, release or
 *    transition a wave.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const EDGE = read("supabase/functions/generate-document/index.ts");
const MENU = read("src/features/warehouse/wave-tower/WaveDocumentsMenu.tsx");
const BOARD = read("src/features/warehouse/wave-tower/WaveLifecycleBoard.tsx");
const MATRIX = read("docs/printing-event-coverage.md");

const TYPES = [
  ["wave_pick_list", "fetchWavePickList"],
  ["wave_summary", "fetchWaveSummary"],
] as const;

describe("wave document registration", () => {
  for (const [type, fetcher] of TYPES) {
    it(`${type} is wired to ${fetcher}`, () => {
      expect(EDGE).toContain(`async function ${fetcher}(`);
      expect(EDGE).toMatch(new RegExp(`${type}:\\s*${fetcher},`));
      expect(EDGE).toMatch(new RegExp(`${type}:\\s*"invoice",`));
      expect(EDGE).toMatch(new RegExp(`${type}:\\s*"wms_pick_waves",`));
      expect(MATRIX).toContain(`\`${type}\``);
    });
  }

  it("the menu dispatches through printDocument, never a render endpoint", () => {
    expect(MENU).toContain('from "@/services/printing/PrintService"');
    expect(MENU).toContain("printDocument(");
    expect(MENU).not.toMatch(/functions\.invoke\(\s*["'`]generate-document/);
    expect(BOARD).toContain("WaveDocumentsMenu");
  });

  it("wave paperwork carries no finance blocks", () => {
    for (const [type] of TYPES) {
      const start = EDGE.indexOf(`  ${type}: {`);
      expect(start).toBeGreaterThan(-1);
      const body = EDGE.slice(start, start + 700);
      expect(body).toContain("show_bank_details: false");
      expect(body).toContain("show_unit_price: false");
    }
  });

  it("the wave fetchers are read models — they never mutate the wave", () => {
    const start = EDGE.indexOf("async function loadWaveBundle(");
    const end = EDGE.indexOf("const TEMPLATE_TYPE_MAP", start);
    const body = EDGE.slice(start, end);
    expect(body).not.toContain("release_pick_wave");
    expect(body).not.toContain("wms_transition_wave");
    expect(body).not.toContain("wms_plan_waves");
    expect(body).not.toMatch(/\.(update|insert|upsert|delete)\(/);
  });
});
