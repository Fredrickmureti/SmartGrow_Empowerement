/**
 * BrowserHardwareAdapter role-routing baseline tests.
 *
 * ADR-0014 Track 4b.5 — locks in the renderer-side adapter behaviour
 * after the legacy HardwareProxy was deleted. Every call now goes
 * through `exec({ role, op, payload })` — the same envelope the
 * Electron main-process CommandRouter validates.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { browserHardwareAdapter, type DeviceAssignment } from "@/services/hardware/BrowserHardwareAdapter";
import * as DriverRegistry from "@/services/hardware/drivers/DriverRegistry";
import type { IDriver, DriverResult } from "@/services/hardware/drivers/DriverInterface";

function mockDriver(overrides: Partial<IDriver> = {}): IDriver {
  const base: IDriver = {
    driverType: "escpos",
    connect: vi.fn(async () => ({ success: true } as DriverResult)),
    disconnect: vi.fn(async () => {}),
    testConnection: vi.fn(async () => true),
    execute: vi.fn(async () => ({ success: true } as DriverResult)),
    getStatus: vi.fn(() => ({ connected: true, status: "online" as const })),
  } as unknown as IDriver;
  return { ...base, ...overrides };
}

describe("BrowserHardwareAdapter role routing", () => {
  beforeEach(async () => {
    await browserHardwareAdapter.disconnectAll();
    browserHardwareAdapter.loadDevices([]);
    vi.restoreAllMocks();
  });

  it("dispatches receipt_printer:print_receipt to the device assigned to receipt_printer", async () => {
    const driver = mockDriver();
    vi.spyOn(DriverRegistry, "createDriver").mockReturnValue(driver);

    const device: DeviceAssignment = {
      id: "dev-1",
      deviceRole: "receipt_printer",
      driverType: "escpos",
      connectionParams: {},
      displayName: "Test Printer",
      isActive: true,
    };
    browserHardwareAdapter.loadDevices([device]);
    await browserHardwareAdapter.connectAll();

    const result = await browserHardwareAdapter.exec({
      role: "receipt_printer",
      op: "print_receipt",
      payload: { lines: [] },
    });
    expect(result.success).toBe(true);
    expect(driver.execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "print_receipt" }),
    );
  });

  it("returns an error when no device is assigned to the role", async () => {
    browserHardwareAdapter.loadDevices([]);
    const result = await browserHardwareAdapter.exec({
      role: "cash_drawer",
      op: "open",
      payload: { pin: 2 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no device assigned/i);
  });

  it("falls back from kitchen_printer to receipt_printer when no kitchen printer is registered", async () => {
    const driver = mockDriver();
    vi.spyOn(DriverRegistry, "createDriver").mockReturnValue(driver);

    browserHardwareAdapter.loadDevices([
      {
        id: "rp",
        deviceRole: "receipt_printer",
        driverType: "escpos",
        connectionParams: {},
        displayName: "Receipt",
        isActive: true,
      },
    ]);
    await browserHardwareAdapter.connectAll();

    const result = await browserHardwareAdapter.exec({
      role: "kitchen_printer",
      op: "print_receipt",
      payload: { lines: [] },
    });
    expect(result.success).toBe(true);
    expect(driver.execute).toHaveBeenCalled();
  });

  it("first active device per role wins; inactive devices are ignored", async () => {
    const driverA = mockDriver();
    const driverB = mockDriver();
    const stub = vi
      .spyOn(DriverRegistry, "createDriver")
      .mockImplementationOnce(() => driverA)
      .mockImplementationOnce(() => driverB);

    browserHardwareAdapter.loadDevices([
      {
        id: "off",
        deviceRole: "receipt_printer",
        driverType: "escpos",
        connectionParams: {},
        displayName: "Disabled",
        isActive: false,
      },
      {
        id: "active-a",
        deviceRole: "receipt_printer",
        driverType: "escpos",
        connectionParams: {},
        displayName: "A",
        isActive: true,
      },
      {
        id: "active-b",
        deviceRole: "receipt_printer",
        driverType: "escpos",
        connectionParams: {},
        displayName: "B",
        isActive: true,
      },
    ]);
    await browserHardwareAdapter.connectAll();
    await browserHardwareAdapter.exec({
      role: "receipt_printer",
      op: "print_receipt",
      payload: { lines: [] },
    });

    // Only the first active device for the role should have been dispatched to.
    expect(driverA.execute).toHaveBeenCalledTimes(1);
    expect(driverB.execute).not.toHaveBeenCalled();
    expect(stub).toHaveBeenCalled();
  });

  it("rejects unsupported role:op combinations with a clear error", async () => {
    const result = await browserHardwareAdapter.exec({
      role: "receipt_printer",
      op: "nonexistent_op",
      payload: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unsupported op/i);
  });
});
