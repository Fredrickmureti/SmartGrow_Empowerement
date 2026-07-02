/**
 * Driver registry — maps `(role, driver)` → factory.
 *
 * Audit Wave 9d.8: `label_printer` now dispatches by `assignment.driver`
 * so a Zebra ZPL printer, an Eltron EPL printer, and an 80mm thermal
 * receipt printer sold as a "label printer" each get the correct byte
 * dialect on the wire. Selection table is centralised here so the
 * renderer + plug-and-play wizard agree on driver_type strings.
 *
 * Supported driver strings for `label_printer`:
 *   - `zpl_label`        → ZplLabelDriver (Zebra ZPL II)
 *   - `epl_label`        → EplLabelDriver (Eltron EPL2)
 *   - `escpos_label`     → EscPosLabelDriver (80mm thermal as label printer)
 *   - anything else / empty → safest default = EscPosLabelDriver (most
 *     common in installed base; producing ESC/POS bytes on a ZPL printer
 *     yields no output, producing ZPL on an ESC/POS printer produces
 *     gibberish — the wizard MUST set this explicitly via probing).
 */

import type { DeviceAssignment } from '../DeviceManager';
import type { IDriver } from './IDriver';
import { EscPosReceiptDriver } from './EscPosReceiptDriver';
import { EscPosKitchenDriver } from './EscPosKitchenDriver';
import { EscPosCashDrawerDriver } from './EscPosCashDrawerDriver';
import { CustomerDisplayDriver } from './CustomerDisplayDriver';
import { SerialScaleDriver } from './SerialScaleDriver';
import { EscPosLabelDriver } from './EscPosLabelDriver';
import { ZplLabelDriver } from './ZplLabelDriver';
import { EplLabelDriver } from './EplLabelDriver';
import { ClockTerminalDriver } from './ClockTerminalDriver';

export { BaseDriver } from './IDriver';
export type { IDriver, DriverHealth, DriverLifecycle } from './IDriver';
export { TransportDriver } from './TransportDriver';
export {
  EscPosReceiptDriver,
  EscPosKitchenDriver,
  EscPosCashDrawerDriver,
  CustomerDisplayDriver,
  SerialScaleDriver,
  EscPosLabelDriver,
  ZplLabelDriver,
  EplLabelDriver,
  ClockTerminalDriver,
};

export { MockDriver, type MockHandled } from './MockDriver';

export const LABEL_DRIVER_TYPES = ['zpl_label', 'epl_label', 'escpos_label'] as const;
export type LabelDriverType = typeof LABEL_DRIVER_TYPES[number];

export function buildDriver(assignment: DeviceAssignment): IDriver | null {
  switch (assignment.role) {
    case 'receipt_printer': return new EscPosReceiptDriver(assignment);
    case 'kitchen_printer': return new EscPosKitchenDriver(assignment);
    case 'cash_drawer': return new EscPosCashDrawerDriver(assignment);
    case 'customer_display': return new CustomerDisplayDriver(assignment);
    case 'scale': return new SerialScaleDriver(assignment);
    case 'label_printer': {
      const driver = String(assignment.driver ?? '').toLowerCase();
      if (driver === 'zpl_label' || driver === 'zpl' || driver === 'zebra') return new ZplLabelDriver(assignment);
      if (driver === 'epl_label' || driver === 'epl' || driver === 'eltron') return new EplLabelDriver(assignment);
      // escpos_label / unknown → ESC/POS thermal fallback. The pnp wizard
      // is the only place that should leave `driver` empty (when an
      // operator skips probing); the receipt-style fallback prints
      // *something* instead of nothing.
      return new EscPosLabelDriver(assignment);
    }
    case 'payment_terminal': return null;
    case 'scanner':
    case 'barcode_scanner': return null;
    // Wave B3.1: attendance/biometric terminals are push-only via the
    // biometric-ingest edge function, but DeviceManager still owns their
    // liveness probe. ClockTerminalDriver provides TCP reachability.
    case 'clock_terminal':
    case 'biometric_reader': return new ClockTerminalDriver(assignment);
    case 'saga': return null;
    default: return null;
  }
}

