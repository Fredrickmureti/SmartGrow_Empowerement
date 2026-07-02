"use strict";
/**
 * Public surface for the Bluetooth subsystem. Importers depend on this
 * barrel only — they never reach into the internal manager/store files.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ipcHealth = exports.ipcDisconnect = exports.ipcConnect = exports.ipcUnpair = exports.ipcPair = exports.ipcList = exports.InMemoryBtPairingsStore = exports.SqliteBtPairingsStore = exports.BT_BACKOFF_MS = exports.nextBackoff = exports.canBtTransition = exports.BluetoothPairingManager = void 0;
exports.setBluetoothPairingManager = setBluetoothPairingManager;
exports.getBluetoothPairingManager = getBluetoothPairingManager;
var BluetoothPairingManager_1 = require("./BluetoothPairingManager");
Object.defineProperty(exports, "BluetoothPairingManager", { enumerable: true, get: function () { return BluetoothPairingManager_1.BluetoothPairingManager; } });
Object.defineProperty(exports, "canBtTransition", { enumerable: true, get: function () { return BluetoothPairingManager_1.canBtTransition; } });
Object.defineProperty(exports, "nextBackoff", { enumerable: true, get: function () { return BluetoothPairingManager_1.nextBackoff; } });
Object.defineProperty(exports, "BT_BACKOFF_MS", { enumerable: true, get: function () { return BluetoothPairingManager_1.BT_BACKOFF_MS; } });
var BtPairingsStore_1 = require("./BtPairingsStore");
Object.defineProperty(exports, "SqliteBtPairingsStore", { enumerable: true, get: function () { return BtPairingsStore_1.SqliteBtPairingsStore; } });
Object.defineProperty(exports, "InMemoryBtPairingsStore", { enumerable: true, get: function () { return BtPairingsStore_1.InMemoryBtPairingsStore; } });
var ipc_1 = require("./ipc");
Object.defineProperty(exports, "ipcList", { enumerable: true, get: function () { return ipc_1.ipcList; } });
Object.defineProperty(exports, "ipcPair", { enumerable: true, get: function () { return ipc_1.ipcPair; } });
Object.defineProperty(exports, "ipcUnpair", { enumerable: true, get: function () { return ipc_1.ipcUnpair; } });
Object.defineProperty(exports, "ipcConnect", { enumerable: true, get: function () { return ipc_1.ipcConnect; } });
Object.defineProperty(exports, "ipcDisconnect", { enumerable: true, get: function () { return ipc_1.ipcDisconnect; } });
Object.defineProperty(exports, "ipcHealth", { enumerable: true, get: function () { return ipc_1.ipcHealth; } });
// Singleton wiring is performed in `electron/main.ts` (needs KeyManager +
// SQLite handle, which are not present in this module's load context).
let _singleton = null;
function setBluetoothPairingManager(m) { _singleton = m; }
function getBluetoothPairingManager() { return _singleton; }
//# sourceMappingURL=index.js.map