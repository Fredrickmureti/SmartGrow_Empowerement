/**
 * Public surface for the Bluetooth subsystem. Importers depend on this
 * barrel only — they never reach into the internal manager/store files.
 */

export { BluetoothPairingManager, canBtTransition, nextBackoff, BT_BACKOFF_MS } from './BluetoothPairingManager';
export type { BtState, BluetoothRadio, BtHealth, PairOptions } from './BluetoothPairingManager';
export { SqliteBtPairingsStore, InMemoryBtPairingsStore } from './BtPairingsStore';
export type { BtPairingsStore, BtPairingRow, KeyManagerLike } from './BtPairingsStore';
export { ipcList, ipcPair, ipcUnpair, ipcConnect, ipcDisconnect, ipcHealth } from './ipc';
export type { SafeBtPairingRow, BtIpcResult, PairInput } from './ipc';

import type { BluetoothPairingManager as Manager } from './BluetoothPairingManager';

// Singleton wiring is performed in `electron/main.ts` (needs KeyManager +
// SQLite handle, which are not present in this module's load context).
let _singleton: Manager | null = null;
export function setBluetoothPairingManager(m: Manager): void { _singleton = m; }
export function getBluetoothPairingManager(): Manager | null { return _singleton; }