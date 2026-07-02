/**
 * Environment detection utilities
 * Detects whether app is running in Electron or browser
 */

// Import the type definition
import '@/types/electron.d';

export const isElectron = (): boolean => {
  // Check for Electron API exposed via preload
  if (typeof window !== 'undefined' && window.pos?.isElectron) {
    return true;
  }
  
  // Fallback check via user agent
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')) {
    return true;
  }
  
  return false;
};

export const getPlatform = (): 'windows' | 'mac' | 'linux' | 'web' => {
  if (!isElectron()) {
    return 'web';
  }
  
  const platform = window.pos?.platform || '';
  
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  
  return 'web';
};

export const supportsNativeHardware = (): boolean => {
  return isElectron();
};

export const supportsWebUSB = (): boolean => {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
};

export const supportsWebSerial = (): boolean => {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
};

export const getHardwareCapabilities = () => ({
  isElectron: isElectron(),
  platform: getPlatform(),
  nativeUSB: isElectron(),
  nativeSerial: isElectron(),
  webUSB: supportsWebUSB(),
  webSerial: supportsWebSerial(),
  // Wave 5: removed the `|| true` short-circuit on canPrint. A capability
  // check that is always `true` is not a capability check. Real native /
  // WebUSB print capability is reported here; the PDF / window.print()
  // fallback is reported separately so callers can render a "fallback
  // only" UX instead of pretending a real printer is attached.
  canPrint: isElectron() || supportsWebUSB(),
  canPrintFallback: true,
  canOpenDrawer: isElectron() || supportsWebUSB(),
  canReadScale: isElectron() || supportsWebSerial(),
});
