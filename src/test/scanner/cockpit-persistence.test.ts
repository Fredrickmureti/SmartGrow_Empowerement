/**
 * @vitest-environment jsdom
 *
 * cockpitPersistence — verifies the sessionStorage snapshot rehydrates
 * correctly, caps recent rows at 50, versions the schema, and isolates
 * different pairing sessions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  saveCockpit,
  loadCockpit,
  clearCockpit,
  cockpitKey,
  type CockpitRow,
} from "@/services/scanner/cockpitPersistence";

function row(i: number, kind: CockpitRow["kind"] = "ok"): CockpitRow {
  return { id: i, code: `CODE-${i}`, kind, at: 1_000 + i };
}

describe("cockpitPersistence", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips a snapshot for a given sessionId", () => {
    saveCockpit("sess-A", {
      recent: [row(1), row(2)],
      scanCount: 2,
      scanTimestamps: [1, 2],
      latencySamples: [10, 20],
      nextId: 2,
    });
    const snap = loadCockpit("sess-A");
    expect(snap).not.toBeNull();
    expect(snap!.recent).toHaveLength(2);
    expect(snap!.scanCount).toBe(2);
    expect(snap!.nextId).toBe(2);
    expect(snap!.v).toBe(1);
  });

  it("caps recent rows at 50 on save", () => {
    const many = Array.from({ length: 200 }, (_, i) => row(i));
    saveCockpit("sess-B", {
      recent: many, scanCount: 200,
      scanTimestamps: [], latencySamples: [], nextId: 200,
    });
    const snap = loadCockpit("sess-B");
    expect(snap!.recent).toHaveLength(50);
  });

  it("isolates separate pairing sessions", () => {
    saveCockpit("sess-A", { recent: [row(1)], scanCount: 1, scanTimestamps: [], latencySamples: [], nextId: 1 });
    saveCockpit("sess-B", { recent: [row(99)], scanCount: 1, scanTimestamps: [], latencySamples: [], nextId: 99 });
    expect(loadCockpit("sess-A")!.recent[0].id).toBe(1);
    expect(loadCockpit("sess-B")!.recent[0].id).toBe(99);
  });

  it("returns null for a missing or version-mismatched snapshot", () => {
    expect(loadCockpit("never")).toBeNull();
    sessionStorage.setItem(cockpitKey("bad"), JSON.stringify({ v: 999, recent: [] }));
    expect(loadCockpit("bad")).toBeNull();
  });

  it("clearCockpit removes the snapshot", () => {
    saveCockpit("sess-X", { recent: [row(1)], scanCount: 1, scanTimestamps: [], latencySamples: [], nextId: 1 });
    expect(loadCockpit("sess-X")).not.toBeNull();
    clearCockpit("sess-X");
    expect(loadCockpit("sess-X")).toBeNull();
  });
});
