/**
 * Guard: the cross-dock saga subscriber must exist and be wired to the
 * receiving-line-captured topic (ADR 0079 · N8, WMS Round 4 · Phase 3.2).
 *
 * Fails if the BusinessSagaMount stops calling
 * `evaluate_crossdock_on_receiving_line` off `WMS_TOPIC.RECEIVING_LINE_CAPTURED`,
 * so a future refactor cannot silently break cross-dock matching.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SAGA = path.resolve(
  __dirname,
  "../../components/events/BusinessSagaMount.tsx",
);

describe("wms crossdock subscriber", () => {
  const src = readFileSync(SAGA, "utf8");

  it("registers a handler on WMS_TOPIC.RECEIVING_LINE_CAPTURED", () => {
    expect(src).toMatch(
      /saga\.register\(\s*WMS_TOPIC\.RECEIVING_LINE_CAPTURED\s*,/,
    );
  });

  it("delegates matching to evaluate_crossdock_on_receiving_line", () => {
    expect(src).toMatch(/evaluate_crossdock_on_receiving_line/);
  });

  it("passes the receiving-line id as p_line_id", () => {
    expect(src).toMatch(/p_line_id\s*:/);
  });
});
