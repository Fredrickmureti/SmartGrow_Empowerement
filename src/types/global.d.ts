/**
 * Ambient type declarations for browser environment.
 * Resolves NodeJS namespace references used by ReturnType<typeof setTimeout>
 * patterns in Vite/browser projects without importing @types/node globally.
 */
declare namespace NodeJS {
  interface Timeout {}
  interface Timer {}
}

/**
 * Ambient shims for the Electron-main-process native modules. These are
 * resolved at runtime from `electron/node_modules/`; the renderer never
 * loads them. We declare them here so type-only references from
 * `electron/hardware/transports/*.ts` (transitively reachable from
 * Vitest tests under `src/test/pos/transports/`) do not break the
 * front-end typecheck.
 */
declare module 'usb' {
  export function getDeviceList(): unknown[];
  export function findByIds(vid: number, pid: number): unknown;
  export interface OutEndpoint {
    direction: 'out';
    transfer(data: Uint8Array, cb: (err?: Error) => void): void;
  }
}
declare module 'serialport' {
  export class SerialPort {
    constructor(opts: Record<string, unknown>);
    static list(): Promise<Array<{
      path: string;
      manufacturer?: string;
      serialNumber?: string;
      vendorId?: string;
      productId?: string;
    }>>;
  }
}

export {};

