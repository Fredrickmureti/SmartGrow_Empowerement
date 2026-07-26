/**
 * Optional `usb` native module loader.
 *
 * `usb` is an optionalDependency: it may be absent (no prebuilt binary for the
 * platform, or install skipped) and in some install layouts resolves without
 * usable type declarations. We load it through a non-literal specifier so the
 * agent compiles identically with or without the package installed.
 */

export type UsbRuntime = any;

const USB_SPECIFIER = 'usb';

let cached: UsbRuntime | null = null;
let attempted = false;

export async function loadUsbRuntime(): Promise<UsbRuntime | null> {
  if (cached) return cached;
  if (attempted) return null;
  attempted = true;
  try {
    const spec: string = USB_SPECIFIER;
    const mod: any = await import(spec);
    cached = (mod?.default ?? mod) as UsbRuntime;
    return cached;
  } catch {
    return null;
  }
}

/** Returns the runtime only if a previous load already succeeded. */
export function usbRuntimeSync(): UsbRuntime | null {
  return cached;
}
