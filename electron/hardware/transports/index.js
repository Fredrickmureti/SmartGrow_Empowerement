"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__setWinSpoolRunner = exports.WinSpoolerTransport = exports.__setCupsRunner = exports.CupsTransport = exports.__setUsbBinding = exports.UsbTransport = exports.__setSerialBinding = exports.SerialTransport = void 0;
/**
 * Transport barrel — every transport implements an `isAvailable()` /
 * `send()` / `test()` / `list()` shape so the DeviceManager can pick
 * one by tag at runtime without importing native modules eagerly.
 */
var SerialTransport_1 = require("./SerialTransport");
Object.defineProperty(exports, "SerialTransport", { enumerable: true, get: function () { return SerialTransport_1.SerialTransport; } });
Object.defineProperty(exports, "__setSerialBinding", { enumerable: true, get: function () { return SerialTransport_1.__setSerialBinding; } });
var UsbTransport_1 = require("./UsbTransport");
Object.defineProperty(exports, "UsbTransport", { enumerable: true, get: function () { return UsbTransport_1.UsbTransport; } });
Object.defineProperty(exports, "__setUsbBinding", { enumerable: true, get: function () { return UsbTransport_1.__setUsbBinding; } });
var CupsTransport_1 = require("./CupsTransport");
Object.defineProperty(exports, "CupsTransport", { enumerable: true, get: function () { return CupsTransport_1.CupsTransport; } });
Object.defineProperty(exports, "__setCupsRunner", { enumerable: true, get: function () { return CupsTransport_1.__setCupsRunner; } });
var WinSpoolerTransport_1 = require("./WinSpoolerTransport");
Object.defineProperty(exports, "WinSpoolerTransport", { enumerable: true, get: function () { return WinSpoolerTransport_1.WinSpoolerTransport; } });
Object.defineProperty(exports, "__setWinSpoolRunner", { enumerable: true, get: function () { return WinSpoolerTransport_1.__setWinSpoolRunner; } });
//# sourceMappingURL=index.js.map