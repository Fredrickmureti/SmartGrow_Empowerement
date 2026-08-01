/**
 * Stage R3b — block-model contract tests.
 *
 * Locks two invariants so the procedural→dispatch refactor in R3b.2
 * (and any future tenant reordering in R3c) cannot silently regress:
 *
 *  1. DEFAULT_BLOCK_ORDER is the canonical block emit sequence consumed
 *     by the Line[] receipt engine (`_shared/receipt/lines.ts`).
 *  2. BLOCK_REGISTRY covers every BlockType — no block can be referenced
 *     without metadata, so the future reorder UI cannot silently drop one.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BLOCK_REGISTRY,
  DEFAULT_BLOCK_ORDER,
  resolveBlockOrder,
  type BlockType,
} from "./blocks.ts";

Deno.test("R3b: BLOCK_REGISTRY has metadata for every BlockType", () => {
  for (const t of DEFAULT_BLOCK_ORDER) {
    const meta = BLOCK_REGISTRY[t];
    assert(meta, `missing registry entry for ${t}`);
    assertEquals(meta.type, t);
    assert(typeof meta.pinned === "boolean");
    assert(meta.label.length > 0);
  }
});

Deno.test("R3b: DEFAULT_BLOCK_ORDER is the canonical emit sequence", () => {
  // This is the order the procedural builder emits today. R3b.2's
  // refactor must produce byte-equal output by iterating exactly this
  // list. If you change the procedural order WITHOUT updating this
  // constant, this test fails — that is intentional.
  const expected: BlockType[] = [
    "custom_header",
    "org_header",
    "title_meta",
    "cashier_register",
    "recipient",
    "items",
    "totals",
    "refund_banner",
    "grand_total",
    "savings",
    "payments",
    "tendered_change",
    "notes",
    "terms",
    "footer_text",
    "return_policy",
    "fiscal_etims_ke",
    "barcode",
    "qr_code",
  ];
  assertEquals([...DEFAULT_BLOCK_ORDER], expected);
});

Deno.test("R3b: resolveBlockOrder defaults to DEFAULT_BLOCK_ORDER (no settings)", () => {
  assertEquals(resolveBlockOrder(null), DEFAULT_BLOCK_ORDER);
  assertEquals(resolveBlockOrder({}), DEFAULT_BLOCK_ORDER);
});
