/**
 * TransportRouter — pure routing matrix.
 *
 * These tests pin the Phase 5 decision matrix. If the matrix changes,
 * update this file in the same commit and note it in `.lovable/plan.md`.
 */
import { describe, it, expect } from "vitest";
import { route, type HostCapabilities } from "@/services/hardware/transport/TransportRouter";

const ELECTRON: HostCapabilities = { isElectron: true,  hasWebUSB: true,  hasWebHID: true };
const BROWSER_FULL: HostCapabilities = { isElectron: false, hasWebUSB: true,  hasWebHID: true };
const BROWSER_MIN:  HostCapabilities = { isElectron: false, hasWebUSB: false, hasWebHID: false };

describe("TransportRouter.route", () => {
  it("routes explicit electron intent to electron_native only in Electron", () => {
    expect(route({ transport: "electron" }, ELECTRON).kind).toBe("electron_native");
    const b = route({ transport: "electron" }, BROWSER_FULL);
    expect(b.kind).toBe("unavailable");
    expect(b.reason).toMatch(/electron host required/i);
  });

  it("routes OS spooler transports (cups/winspool) to electron_native, unavailable in browser", () => {
    for (const t of ["cups", "winspool"] as const) {
      expect(route({ transport: t }, ELECTRON).kind).toBe("electron_native");
      expect(route({ transport: t }, BROWSER_FULL).kind).toBe("unavailable");
    }
  });

  it("routes local_agent identically from either host", () => {
    expect(route({ transport: "local_agent" }, ELECTRON).kind).toBe("local_agent");
    expect(route({ transport: "local_agent" }, BROWSER_FULL).kind).toBe("local_agent");
  });

  it("routes webusb → electron_native inside Electron, webusb in capable browser, unavailable otherwise", () => {
    expect(route({ transport: "webusb" }, ELECTRON).kind).toBe("electron_native");
    expect(route({ transport: "webusb" }, BROWSER_FULL).kind).toBe("webusb");
    expect(route({ transport: "webusb" }, BROWSER_MIN).kind).toBe("unavailable");
  });

  it("routes webhid → electron_native inside Electron, webhid in capable browser, unavailable otherwise", () => {
    expect(route({ transport: "webhid" }, ELECTRON).kind).toBe("electron_native");
    expect(route({ transport: "webhid" }, BROWSER_FULL).kind).toBe("webhid");
    expect(route({ transport: "webhid" }, BROWSER_MIN).kind).toBe("unavailable");
  });

  it("normalises pre-Wave-9d legacy transport aliases to local_agent", () => {
    for (const t of ["usb", "serial", "network"]) {
      const d = route({ transport: t }, BROWSER_FULL);
      expect(d.kind).toBe("local_agent");
      expect(d.requestedTransport).toBe("local_agent");
    }
  });

  it("returns unavailable when the assignment is disabled", () => {
    const d = route({ transport: "webusb", enabled: false }, BROWSER_FULL);
    expect(d.kind).toBe("unavailable");
    expect(d.reason).toMatch(/disabled/i);
  });

  it("returns unavailable for an unknown transport value", () => {
    const d = route({ transport: "carrier_pigeon" }, BROWSER_FULL);
    expect(d.kind).toBe("unavailable");
    expect(d.reason).toMatch(/unknown transport/i);
  });
});
