"use strict";
/**
 * EventBroker — broadcasts hardware events to every renderer window.
 *
 * Replaces the renderer-only `HardwareEventBus`. DeviceManager / drivers
 * publish here; the broker pushes a `pos:event` IPC message to the main
 * POS window, the customer-display window, and any future kitchen
 * window. Renderers subscribe once via `window.pos.hardware.subscribe`.
 *
 * Decoupled from Electron in the constructor so it can be unit-tested.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventBroker = exports.EventBroker = void 0;
class EventBroker {
    constructor() {
        this.sinks = [];
        this.windows = [];
    }
    /** Add a programmatic sink (used by SaleSaga, tests, etc.). */
    subscribe(sink) {
        this.sinks.push(sink);
        return () => {
            this.sinks = this.sinks.filter(s => s !== sink);
        };
    }
    /** Register an Electron BrowserWindow's webContents-like object. */
    addWindow(win) {
        this.windows.push(win);
        return () => {
            this.windows = this.windows.filter(w => w !== win);
        };
    }
    publish(event) {
        for (const sink of this.sinks) {
            try {
                sink(event);
            }
            catch { /* swallow */ }
        }
        for (const win of this.windows) {
            if (win.isDestroyed())
                continue;
            try {
                win.send('pos:event', event);
            }
            catch { /* swallow */ }
        }
    }
    /** Test helper. */
    _reset() {
        this.sinks = [];
        this.windows = [];
    }
}
exports.EventBroker = EventBroker;
exports.eventBroker = new EventBroker();
//# sourceMappingURL=EventBroker.js.map