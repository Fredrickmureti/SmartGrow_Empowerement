/**
 * Driver Registry — Maps driver_type strings to driver factory functions.
 *
 * Wave 6: every renderer driver that overlaps with a main-process driver
 * MUST be registered with `{ browserFallback: true }`. The main-process
 * driver (under `electron/hardware/drivers/`) is the production runtime;
 * the renderer driver only runs when the app is open in a plain browser
 * (no Electron preload) and serves as a degraded fallback. The
 * `hardware-driver-duplication.test.ts` architecture guard fails the
 * build if this invariant is violated.
 *
 * Drivers that have NO main-process counterpart (scanners, payment-terminal
 * stubs) remain `browserFallback: false` and are the primary path even
 * inside Electron — those roles are renderer-owned by design.
 */

import type { IDriver, DriverType, DeviceRole, DeviceInfo } from './DriverInterface';
import { EscPosPrinterDriver } from './EscPosPrinterDriver';
import { EscPosCashDrawerDriver } from './EscPosCashDrawerDriver';
import { SerialScaleDriver } from './SerialScaleDriver';
import { CustomerDisplayDriver } from './CustomerDisplayDriver';
import { BrowserPrintDriver } from './BrowserPrintDriver';
import { PaymentTerminalDriver } from './PaymentTerminalDriver';
import { KeyboardScannerDriver } from './KeyboardScannerDriver';
import { HidScannerDriver } from './HidScannerDriver';
import { LineDisplayDriver } from './LineDisplayDriver';
import { EposPrinterDriver } from './EposPrinterDriver';
import { ZplLabelDriver, EplLabelDriver, EscPosLabelDriver } from './LabelPrinterDrivers';

type DriverFactory = () => IDriver;

export interface DriverMetadata {
  /** True if a main-process driver covers this driver's role and the renderer
   *  implementation only exists as a browser fallback. */
  browserFallback: boolean;
}

interface RegistryEntry {
  factory: DriverFactory;
  meta: DriverMetadata;
}

const driverFactories = new Map<DriverType, RegistryEntry>();

/**
 * Register a driver factory. Pass `{ browserFallback: true }` when a
 * main-process driver covers the same role.
 */
export function registerDriver(
  driverType: DriverType,
  factory: DriverFactory,
  meta: DriverMetadata = { browserFallback: false },
): void {
  driverFactories.set(driverType, { factory, meta });
}

export function createDriver(driverType: DriverType): IDriver | null {
  const entry = driverFactories.get(driverType);
  if (!entry) {
    console.warn(`[DriverRegistry] No driver registered for type: ${driverType}`);
    return null;
  }
  return entry.factory();
}

export function getDriverMetadata(driverType: DriverType): DriverMetadata | null {
  return driverFactories.get(driverType)?.meta ?? null;
}

export function getRegisteredDriverTypes(): DriverType[] {
  return Array.from(driverFactories.keys());
}

export function getDriversForRole(role: DeviceRole): { driverType: DriverType; label: string }[] {
  const result: { driverType: DriverType; label: string }[] = [];
  for (const [type, entry] of driverFactories) {
    const driver = entry.factory();
    if (driver.supportedRoles.includes(role)) {
      result.push({ driverType: type, label: formatDriverLabel(type) });
    }
  }
  return result;
}

export function getBackendsForDriver(driverType: DriverType): string[] {
  const entry = driverFactories.get(driverType);
  if (!entry) return [];
  const driver = entry.factory();
  return [...driver.supportedBackends];
}

export function matchDriverForDevice(deviceInfo: DeviceInfo): { driverType: DriverType; score: number } | null {
  let bestType: DriverType | null = null;
  let bestScore = 0;

  for (const [type, entry] of driverFactories) {
    const driver = entry.factory();
    const score = driver.supported(deviceInfo);
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  if (bestType && bestScore > 0) {
    return { driverType: bestType, score: bestScore };
  }
  return null;
}

function formatDriverLabel(type: DriverType): string {
  const labels: Record<string, string> = {
    escpos: 'ESC/POS (Generic)',
    star: 'Star Micronics (ESC/POS)',
    citizen: 'Citizen (ESC/POS)',
    bixolon: 'Bixolon (ESC/POS)',
    epson: 'Epson (ESC/POS)',
    epos_printer: 'Epson ePOS (Direct HTTP)',
    zpl_label: 'Zebra / ZPL Label',
    epl_label: 'Eltron / EPL Label',
    escpos_label: 'ESC/POS Label (Generic)',
    escpos_drawer: 'Via Receipt Printer (RJ-11)',
    generic_scale: 'Generic Scale',
    toledo_scale: 'Toledo / Mettler-Toledo',
    cas_scale: 'CAS Scale',
    mettler_scale: 'Mettler Scale',
    keyboard_scanner: 'Keyboard Emulation',
    hid_scanner: 'USB HID Scanner',
    secondary_screen_display: 'Secondary Screen',
    line_display: 'Line Display (VFD/LCD)',
    browser_print: 'Browser Print (Fallback)',
    worldline_terminal: 'Worldline / SIX ⚠️ Pending',
    adyen_terminal: 'Adyen ⚠️ Pending',
    generic_terminal: 'Generic Terminal ⚠️ Pending',
  };
  return labels[type] || type;
}

// ───────────────── Built-in driver registrations ─────────────────
//
// browserFallback: true  → main-process driver covers the role; this is a
//                          renderer fallback used only outside Electron.
// browserFallback: false → no main-process equivalent (or this role is
//                          renderer-owned by design, e.g. scanners).

// ESC/POS printers — receipt/kitchen role; covered by main process
registerDriver('escpos',   () => new EscPosPrinterDriver(), { browserFallback: true });
registerDriver('star',     () => new EscPosPrinterDriver(), { browserFallback: true });
registerDriver('citizen',  () => new EscPosPrinterDriver(), { browserFallback: true });
registerDriver('bixolon',  () => new EscPosPrinterDriver(), { browserFallback: true });
registerDriver('epson',    () => new EscPosPrinterDriver(), { browserFallback: true });

// Cash drawer — covered by main process
registerDriver('escpos_drawer', () => new EscPosCashDrawerDriver(), { browserFallback: true });

// Scales — covered by main process
registerDriver('generic_scale', () => new SerialScaleDriver('generic'), { browserFallback: true });
registerDriver('toledo_scale',  () => new SerialScaleDriver('toledo'),  { browserFallback: true });
registerDriver('cas_scale',     () => new SerialScaleDriver('cas'),     { browserFallback: true });
registerDriver('mettler_scale', () => new SerialScaleDriver('generic'), { browserFallback: true });

// Customer display — covered by main process
registerDriver('secondary_screen_display', () => new CustomerDisplayDriver(), { browserFallback: true });

// Browser print — fallback by definition
registerDriver('browser_print', () => new BrowserPrintDriver(), { browserFallback: true });

// Epson ePOS — LAN HTTP path. Reaches a real printer even without Electron,
// but Electron's main-process ESC/POS driver is preferred when available.
registerDriver('epos_printer', () => new EposPrinterDriver(), { browserFallback: true });

// Label printers — covered by main-process ZPL/EPL/ESC/POS-label drivers.
registerDriver('zpl_label',    () => new ZplLabelDriver(),    { browserFallback: true });
registerDriver('epl_label',    () => new EplLabelDriver(),    { browserFallback: true });
registerDriver('escpos_label', () => new EscPosLabelDriver(), { browserFallback: true });

// Payment terminals — stubs, no main-process equivalent yet.
registerDriver('worldline_terminal', () => new PaymentTerminalDriver('worldline'));
registerDriver('adyen_terminal',     () => new PaymentTerminalDriver('adyen'));
registerDriver('generic_terminal',   () => new PaymentTerminalDriver('generic'));

// Scanners — renderer-owned by design (HID/keyboard wedge), no main driver.
registerDriver('keyboard_scanner', () => new KeyboardScannerDriver());
registerDriver('hid_scanner',      () => new HidScannerDriver());

// Line display — Wave 11 R4: marked browserFallback so Electron mode
// routes to the main-process CustomerDisplayDriver (the renderer stub
// pointed at electronBridgeDead and failed silently for every Electron
// install). Browser-only installs still see the renderer driver.
registerDriver('line_display', () => new LineDisplayDriver(), { browserFallback: true });

