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

import type { HardwareEvent } from './types';

type Sink = (event: HardwareEvent) => void;

/** Abstracts `BrowserWindow.webContents.send` for testability. */
export interface WindowSink {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export class EventBroker {
  private sinks: Sink[] = [];
  private windows: WindowSink[] = [];

  /** Add a programmatic sink (used by SaleSaga, tests, etc.). */
  subscribe(sink: Sink): () => void {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter(s => s !== sink);
    };
  }

  /** Register an Electron BrowserWindow's webContents-like object. */
  addWindow(win: WindowSink): () => void {
    this.windows.push(win);
    return () => {
      this.windows = this.windows.filter(w => w !== win);
    };
  }

  publish(event: HardwareEvent): void {
    for (const sink of this.sinks) {
      try { sink(event); } catch { /* swallow */ }
    }
    for (const win of this.windows) {
      if (win.isDestroyed()) continue;
      try { win.send('pos:event', event); } catch { /* swallow */ }
    }
  }

  /** Test helper. */
  _reset(): void {
    this.sinks = [];
    this.windows = [];
  }
}

export const eventBroker = new EventBroker();
