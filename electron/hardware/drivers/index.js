"use strict";
/**
 * Driver registry — maps `(role, driver-name)` → factory.
 *
 * DeviceManager calls `buildDriver(assignment)` for each enabled
 * assignment on bootstrap. New drivers register themselves here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockDriver = exports.SerialScaleDriver = exports.CustomerDisplayDriver = exports.EscPosCashDrawerDriver = exports.EscPosKitchenDriver = exports.EscPosReceiptDriver = exports.TransportDriver = exports.BaseDriver = void 0;
exports.buildDriver = buildDriver;
const EscPosReceiptDriver_1 = require("./EscPosReceiptDriver");
Object.defineProperty(exports, "EscPosReceiptDriver", { enumerable: true, get: function () { return EscPosReceiptDriver_1.EscPosReceiptDriver; } });
const EscPosKitchenDriver_1 = require("./EscPosKitchenDriver");
Object.defineProperty(exports, "EscPosKitchenDriver", { enumerable: true, get: function () { return EscPosKitchenDriver_1.EscPosKitchenDriver; } });
const EscPosCashDrawerDriver_1 = require("./EscPosCashDrawerDriver");
Object.defineProperty(exports, "EscPosCashDrawerDriver", { enumerable: true, get: function () { return EscPosCashDrawerDriver_1.EscPosCashDrawerDriver; } });
const CustomerDisplayDriver_1 = require("./CustomerDisplayDriver");
Object.defineProperty(exports, "CustomerDisplayDriver", { enumerable: true, get: function () { return CustomerDisplayDriver_1.CustomerDisplayDriver; } });
const SerialScaleDriver_1 = require("./SerialScaleDriver");
Object.defineProperty(exports, "SerialScaleDriver", { enumerable: true, get: function () { return SerialScaleDriver_1.SerialScaleDriver; } });
var IDriver_1 = require("./IDriver");
Object.defineProperty(exports, "BaseDriver", { enumerable: true, get: function () { return IDriver_1.BaseDriver; } });
var TransportDriver_1 = require("./TransportDriver");
Object.defineProperty(exports, "TransportDriver", { enumerable: true, get: function () { return TransportDriver_1.TransportDriver; } });
var MockDriver_1 = require("./MockDriver");
Object.defineProperty(exports, "MockDriver", { enumerable: true, get: function () { return MockDriver_1.MockDriver; } });
function buildDriver(assignment) {
    switch (assignment.role) {
        case 'receipt_printer': return new EscPosReceiptDriver_1.EscPosReceiptDriver(assignment);
        case 'kitchen_printer': return new EscPosKitchenDriver_1.EscPosKitchenDriver(assignment);
        case 'cash_drawer': return new EscPosCashDrawerDriver_1.EscPosCashDrawerDriver(assignment);
        case 'customer_display': return new CustomerDisplayDriver_1.CustomerDisplayDriver(assignment);
        case 'scale': return new SerialScaleDriver_1.SerialScaleDriver(assignment);
        // payment_terminal lives under electron/hardware/payment/ — DeviceManager
        // wires it separately because it owns a FSM, not just a transport.
        case 'payment_terminal': return null;
        case 'scanner': return null; // scanner is renderer-side (HID/keyboard)
        default: return null;
    }
}
//# sourceMappingURL=index.js.map