/**
 * Transport barrel — every transport implements an `isAvailable()` /
 * `send()` / `test()` / `list()` shape so the DeviceManager can pick
 * one by tag at runtime without importing native modules eagerly.
 */
export { SerialTransport, __setSerialBinding } from './SerialTransport';
export type {
  SerialOpenOptions, SerialSendResult, SerialListedPort, SerialPortBinding, SerialPortHandle,
} from './SerialTransport';

export { UsbTransport, __setUsbBinding } from './UsbTransport';
export type {
  UsbDeviceTarget, UsbSendResult, UsbListedDevice, UsbBinding,
} from './UsbTransport';

export { CupsTransport, __setCupsRunner } from './CupsTransport';
export type { CupsTarget, CupsSendResult, ShellRunner } from './CupsTransport';

export { WinSpoolerTransport, __setWinSpoolRunner } from './WinSpoolerTransport';
export type { WinSpoolTarget, WinSpoolSendResult, PowerShellRunner } from './WinSpoolerTransport';
