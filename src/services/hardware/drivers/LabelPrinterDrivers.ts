/**
 * Label Printer Drivers — renderer-side thin classes for `label_printer` role.
 *
 * Mirror the main-process drivers under `electron/hardware/drivers/`
 * (ZplLabelDriver / EplLabelDriver / EscPosLabelDriver). All three are
 * transport-only: they accept server-rendered bytes (ZPL, EPL, or ESC/POS)
 * via `print_raw` / `print_receipt` and forward them through the resolved
 * transport. Registered as `browserFallback: true` because the main-process
 * drivers are the production runtime; the renderer classes only exist so
 * that (a) `getDriversForRole('label_printer')` returns the correct set in
 * both UIs, and (b) plain-browser installs still have a code path.
 *
 * We subclass EscPosPrinterDriver to reuse its transport lifecycle
 * (connect / disconnect / status / testConnection / execute); only the
 * driverType identifier changes, plus the supported role/backends set.
 */
import { EscPosPrinterDriver } from './EscPosPrinterDriver';
import type { DriverType, DeviceRole, ConnectionBackend } from './DriverInterface';

export class ZplLabelDriver extends EscPosPrinterDriver {
  override readonly driverType: DriverType = 'zpl_label';
  override readonly supportedRoles: DeviceRole[] = ['label_printer'];
  override readonly supportedBackends: ConnectionBackend[] = ['electron', 'webusb', 'local_proxy', 'network'];
}

export class EplLabelDriver extends EscPosPrinterDriver {
  override readonly driverType: DriverType = 'epl_label';
  override readonly supportedRoles: DeviceRole[] = ['label_printer'];
  override readonly supportedBackends: ConnectionBackend[] = ['electron', 'webusb', 'local_proxy', 'network'];
}

export class EscPosLabelDriver extends EscPosPrinterDriver {
  override readonly driverType: DriverType = 'escpos_label';
  override readonly supportedRoles: DeviceRole[] = ['label_printer'];
  override readonly supportedBackends: ConnectionBackend[] = ['electron', 'webusb', 'local_proxy', 'network'];
}