/**
 * Table tests for the GS1 parser. Every AI covered in `aiTable.ts` gets
 * at least one round-trip case here. Boundary cases (FNC1 handling,
 * fixed vs variable, day-00 expiry, symbology prefix) get dedicated
 * assertions.
 */
import { describe, it, expect } from "vitest";
import { parseGs1, isGs1Payload } from "./parseGs1";
import { FNC1 } from "./aiTable";

const GS = FNC1;

describe("parseGs1 — fixed-length AIs", () => {
  it("parses GTIN (01)", () => {
    const r = parseGs1("0103453120000011");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.gtin).toBe("03453120000011");
  });

  it("parses expiry (17) as YYMMDD with day=00 → last day of month", () => {
    const r = parseGs1("0103453120000011" + "17250200");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.expiry?.getUTCFullYear()).toBe(2025);
      expect(r.normalized.expiry?.getUTCMonth()).toBe(1); // Feb
      expect(r.normalized.expiry?.getUTCDate()).toBe(28);
    }
  });

  it("parses expiry (17) with an explicit day", () => {
    const r = parseGs1("0103453120000011" + "17260731");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.expiry?.getUTCFullYear()).toBe(2026);
      expect(r.normalized.expiry?.getUTCMonth()).toBe(6);
      expect(r.normalized.expiry?.getUTCDate()).toBe(31);
    }
  });
});

describe("parseGs1 — variable-length AIs need FNC1", () => {
  it("terminates lot (10) at FNC1", () => {
    const r = parseGs1("0103453120000011" + "10ABC1234" + GS + "21XYZ987");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.lot).toBe("ABC1234");
      expect(r.normalized.serial).toBe("XYZ987");
    }
  });

  it("consumes lot to end of input when no FNC1 follows", () => {
    const r = parseGs1("10ABC1234");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.lot).toBe("ABC1234");
  });

  it("full carton label: GTIN + lot + expiry + serial", () => {
    const raw = "01034531200000111709112510ABC1234" + GS + "21XYZ987";
    const r = parseGs1(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.gtin).toBe("03453120000011");
      expect(r.normalized.expiry?.getUTCFullYear()).toBe(2017);
      expect(r.normalized.lot).toBe("ABC1234");
      expect(r.normalized.serial).toBe("XYZ987");
    }
  });
});

describe("parseGs1 — decimal-indicator AIs (310n)", () => {
  it("parses net weight with 3 decimals", () => {
    // 3103 = net weight kg, 3 decimals. Value 001750 → 1.750 kg.
    const r = parseGs1("0103453120000011" + "3103001750");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.netWeightKg).toBeCloseTo(1.75, 3);
  });
});

describe("parseGs1 — count (30)", () => {
  it("parses count as numeric quantity", () => {
    const r = parseGs1("0103453120000011" + "3024" + GS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.quantity).toBe(24);
  });
});

describe("parseGs1 — symbology prefix + leading FNC1", () => {
  it("strips ]C1 (GS1-128 symbology identifier)", () => {
    const r = parseGs1("]C1" + "0103453120000011");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.gtin).toBe("03453120000011");
  });

  it("strips a leading FNC1", () => {
    const r = parseGs1(GS + "0103453120000011");
    expect(r.ok).toBe(true);
  });
});

describe("parseGs1 — failure modes", () => {
  it("rejects an empty payload", () => {
    expect(parseGs1("").ok).toBe(false);
  });

  it("rejects a non-GS1 payload", () => {
    expect(parseGs1("HELLOWORLD").ok).toBe(false);
    expect(isGs1Payload("HELLOWORLD")).toBe(false);
  });

  it("rejects truncated fixed AI", () => {
    expect(parseGs1("0112345").ok).toBe(false); // GTIN needs 14 digits
  });
});
