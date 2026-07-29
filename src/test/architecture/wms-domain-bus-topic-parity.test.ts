/**
 * Architecture guard — every canonical WMS topic must be reachable from
 * both the domain event bus type and the saga registration loop.
 *
 * The bus expresses this via the `WmsTopic` union imported from the
 * topics module; the saga iterates `Object.values(WMS_TOPIC)`. If either
 * indirection is severed, the drift class that produced the Round-3 red
 * `wms-phase7` guard reappears — this test pins the invariant explicitly
 * for the whole vocabulary.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { WMS_TOPIC } from "../../features/warehouse/events/topics";

const SRC = path.resolve(__dirname, "../..");

describe("wms domain-bus topic parity", () => {
  it("domainEventBus accepts the WmsTopic union", () => {
    const bus = readFileSync(path.join(SRC, "services/events/domainEventBus.ts"), "utf8");
    expect(bus).toMatch(/from\s+["']@\/features\/warehouse\/events\/topics["']/);
    expect(bus).toMatch(/\bWmsTopic\b/);
  });

  it("BusinessSagaMount registers a handler for every WMS_TOPIC value", () => {
    const saga = readFileSync(path.join(SRC, "components/events/BusinessSagaMount.tsx"), "utf8");
    expect(saga).toMatch(/from\s+["']@\/features\/warehouse\/events\/topics["']/);
    expect(saga).toMatch(/Object\.values\(WMS_TOPIC\)/);
    expect(saga).toMatch(/saga\.register\(\s*topic\s*,/);
  });

  it("WMS_TOPIC has no duplicate string values", () => {
    const values = Object.values(WMS_TOPIC);
    expect(new Set(values).size).toBe(values.length);
  });

  it("every WMS_TOPIC value is a warehouse.* topic", () => {
    for (const v of Object.values(WMS_TOPIC)) {
      expect(v.startsWith("warehouse.")).toBe(true);
    }
  });
});
