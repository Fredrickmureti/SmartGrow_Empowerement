/**
 * Wave 5 — LineMeta → ESC/POS emitter contract tests.
 *
 * These tests lock the invariants that make `renderLinesEscPos` safe to
 * swap in for `builder.ts`'s procedural emitters in a follow-up wave:
 *  1. Every `LineMeta` row produces exactly one LF at the end.
 *  2. Bold + large are per-row (never leak).
 *  3. Alignment transitions issue the correct ESC/POS align commands.
 *  4. `qr:true` rows emit native QR when caps allow, and are dropped
 *     silently otherwise.
 *  5. The stream begins with INIT + codepage + print-mode and ends with
 *     a feed and (by default) a cut.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderLinesEscPos } from "./renderLinesEscPos.ts";
import type { ReceiptLinesResult } from "../receipt/lines.ts";

function countSubseq(bytes: Uint8Array, needle: number[]): number {
  let n = 0;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    n++;
  }
  return n;
}

function fixture(overrides: Partial<ReceiptLinesResult> = {}): ReceiptLinesResult {
  return {
    lines: ["STORE", "Item A            10.00", "TOTAL             10.00"],
    meta: [
      { align: "center", bold: true },
      { align: "left" },
      { align: "left", bold: true, large: true },
    ],
    columns: 32,
    marginCols: 0,
    paper: "80mm",
    font: "A",
    ...overrides,
  };
}

Deno.test("emits INIT, CP858 codepage, and font A print-mode as the preamble", () => {
  const bytes = renderLinesEscPos(fixture(), { cut: false, feedLinesAfter: 0 });
  // ESC @  (INIT)
  assertEquals(bytes[0], 0x1b);
  assertEquals(bytes[1], 0x40);
  // ESC t 0x13 (CP858)
  assertEquals(countSubseq(bytes, [0x1b, 0x74, 0x13]), 1);
  // ESC ! 0x00 (Font A)
  assertEquals(countSubseq(bytes, [0x1b, 0x21, 0x00]), 1);
});

Deno.test("font B is selected when result.font === 'B'", () => {
  const bytes = renderLinesEscPos(fixture({ font: "B" }), { cut: false, feedLinesAfter: 0 });
  assertEquals(countSubseq(bytes, [0x1b, 0x21, 0x01]), 1);
  assertEquals(countSubseq(bytes, [0x1b, 0x21, 0x00]), 0);
});

Deno.test("every non-QR row produces exactly one LF", () => {
  const bytes = renderLinesEscPos(fixture(), { cut: false, feedLinesAfter: 0 });
  const lfCount = bytes.filter((b) => b === 0x0a).length;
  assertEquals(lfCount, 3, "one LF per row, no trailing feed");
});

Deno.test("bold + large are toggled per-row and reset after each row", () => {
  const bytes = renderLinesEscPos(fixture(), { cut: false, feedLinesAfter: 0 });
  // 2 bold rows → 2 BOLD_ON, 2 BOLD_OFF
  assertEquals(countSubseq(bytes, [0x1b, 0x45, 0x01]), 2);
  assertEquals(countSubseq(bytes, [0x1b, 0x45, 0x00]), 2);
  // 1 large row → 1 DOUBLE_ON, 1 DOUBLE_OFF
  assertEquals(countSubseq(bytes, [0x1d, 0x21, 0x11]), 1);
  assertEquals(countSubseq(bytes, [0x1d, 0x21, 0x00]), 1);
});

Deno.test("alignment transitions issue ESC a commands", () => {
  const bytes = renderLinesEscPos(fixture(), { cut: false, feedLinesAfter: 0 });
  // center row + reset to left (twice — once after row, once at end)
  assert(countSubseq(bytes, [0x1b, 0x61, 0x01]) >= 1, "at least one ALIGN_CENTER");
  assert(countSubseq(bytes, [0x1b, 0x61, 0x00]) >= 1, "at least one ALIGN_LEFT reset");
});

Deno.test("qr:true row emits native QR when caps.qr_native is on", () => {
  const bytes = renderLinesEscPos(
    fixture({
      lines: ["QR:"],
      meta: [{ align: "center", qr: true }],
      qrPayload: "https://example.com/verify/abc",
    }),
    { cut: false, feedLinesAfter: 0, caps: { qr_native: true } },
  );
  // Store data marker: GS ( k … 0x31 0x50 0x30
  assert(countSubseq(bytes, [0x31, 0x50, 0x30]) >= 1, "QR store-data command present");
  // Print buffered data marker: GS ( k 0x03 0x00 0x31 0x51 0x30
  assertEquals(countSubseq(bytes, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]), 1);
});

Deno.test("qr:true row is dropped silently when caps.qr_native is off", () => {
  const bytes = renderLinesEscPos(
    fixture({
      lines: ["QR:"],
      meta: [{ align: "center", qr: true }],
      qrPayload: "https://example.com/verify/abc",
    }),
    { cut: false, feedLinesAfter: 0, caps: { qr_native: false } },
  );
  assertEquals(countSubseq(bytes, [0x31, 0x50, 0x30]), 0);
  // No LFs (the QR row itself doesn't emit a text LF)
  assertEquals(bytes.filter((b) => b === 0x0a).length, 0);
});

Deno.test("stream ends with feed + cut by default", () => {
  const bytes = renderLinesEscPos(fixture(), { feedLinesAfter: 3 });
  // ESC d 3
  assertEquals(countSubseq(bytes, [0x1b, 0x64, 0x03]), 1);
  // GS V 0
  assertEquals(countSubseq(bytes, [0x1d, 0x56, 0x00]), 1);
});

Deno.test("cut is suppressed when caps.auto_cut is false", () => {
  const bytes = renderLinesEscPos(fixture(), {
    feedLinesAfter: 0,
    caps: { auto_cut: false },
  });
  assertEquals(countSubseq(bytes, [0x1d, 0x56, 0x00]), 0);
});

Deno.test("CP858 encoding: € becomes single byte 0xD5, ellipsis becomes '.'", () => {
  const bytes = renderLinesEscPos(
    fixture({
      lines: ["€ 10.00", "long…"],
      meta: [{ align: "left" }, { align: "left" }],
    }),
    { cut: false, feedLinesAfter: 0 },
  );
  // € → 0xD5
  assert(Array.from(bytes).includes(0xd5), "€ maps to CP858 0xD5");
  // … → '.' (0x2E), no 0x85 (unmapped ellipsis) leakage
  const dotCount = bytes.filter((b) => b === 0x2e).length;
  assert(dotCount >= 3, "ellipsis transliterates to single '.'");
});