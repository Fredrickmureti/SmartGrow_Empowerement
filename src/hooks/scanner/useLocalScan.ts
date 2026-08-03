/**
 * useLocalScan — handheld-mode helper for scan surfaces.
 *
 * Returns whether this device should offer its own camera as the scanner
 * (`handheld`), plus the single sanctioned way to open the viewfinder.
 * Reacts to the operator's persisted device-mode override.
 */
import { useCallback, useEffect, useState } from "react";
import {
  scannerDeviceMode,
  type ScannerDeviceMode,
  type ScannerDeviceModePreference,
} from "@/services/scanner/camera/deviceMode";
import { openLocalScan, type LocalScanRequest } from "@/services/scanner/camera/localScanService";

export interface UseLocalScanResult {
  /** Effective mode for this device. */
  mode: ScannerDeviceMode;
  /** Convenience: `mode === "handheld"`. */
  handheld: boolean;
  /** Raw preference including "auto". */
  preference: ScannerDeviceModePreference;
  setPreference: (next: ScannerDeviceModePreference) => void;
  /** Open the device-local viewfinder. */
  scan: (req?: LocalScanRequest) => void;
}

export function useLocalScan(): UseLocalScanResult {
  const [preference, setPreferenceState] = useState<ScannerDeviceModePreference>(() =>
    scannerDeviceMode.getPreference(),
  );

  useEffect(() => scannerDeviceMode.subscribe(setPreferenceState), []);

  const setPreference = useCallback((next: ScannerDeviceModePreference) => {
    scannerDeviceMode.set(next);
  }, []);

  const scan = useCallback((req: LocalScanRequest = {}) => openLocalScan(req), []);

  const mode: ScannerDeviceMode =
    preference === "auto" ? scannerDeviceMode.get() : preference;

  return { mode, handheld: mode === "handheld", preference, setPreference, scan };
}
