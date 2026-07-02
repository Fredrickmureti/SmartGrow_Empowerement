/**
 * Hardware Event Bus — Central pub/sub for all hardware events.
 * 
 * Replaces scattered DOM CustomEvents (pos:barcode_scanned, etc.)
 * with a typed, centralized event system like Odoo's event_manager.
 * 
 * Usage:
 *   hardwareEventBus.on('scanner:barcode_scanned', ({ barcode }) => { ... });
 *   hardwareEventBus.emit('scanner:barcode_scanned', { barcode: '123456' });
 */

export type HardwareEventType =
  // Device lifecycle
  | 'device:connected'
  | 'device:disconnected'
  | 'device:error'
  | 'device:discovered'
  // Scanner
  | 'scanner:barcode_scanned'
  // Scale
  | 'scale:weight_changed'
  | 'scale:stable'
  | 'scale:tared'
  // Printer
  | 'printer:print_complete'
  | 'printer:print_error'
  | 'printer:paper_low'
  // Cash drawer
  | 'drawer:opened'
  | 'drawer:closed'
  // Payment terminal
  | 'terminal:payment_approved'
  | 'terminal:payment_declined'
  | 'terminal:payment_cancelled'
  // Display
  | 'display:updated'
  | 'display:disconnected';

export interface HardwareEvent {
  type: HardwareEventType;
  deviceId?: string;
  deviceRole?: string;
  timestamp: number;
  data?: unknown;
}

export interface DeviceDiscoveredData {
  identifier: string;
  name: string;
  vendorId?: number;
  productId?: number;
  connectionType: string;
  suggestedDriverType?: string;
  suggestedRole?: string;
}

type EventCallback = (event: HardwareEvent) => void;

class HardwareEventBusService {
  private listeners = new Map<HardwareEventType, Set<EventCallback>>();
  private globalListeners = new Set<EventCallback>();

  /**
   * Subscribe to a specific event type
   */
  on(type: HardwareEventType, callback: EventCallback): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(type)?.delete(callback);
    };
  }

  /**
   * Subscribe to ALL events (useful for logging/debugging)
   */
  onAll(callback: EventCallback): () => void {
    this.globalListeners.add(callback);
    return () => {
      this.globalListeners.delete(callback);
    };
  }

  /**
   * Emit an event
   */
  emit(type: HardwareEventType, data?: unknown, deviceId?: string, deviceRole?: string): void {
    const event: HardwareEvent = {
      type,
      deviceId,
      deviceRole,
      timestamp: Date.now(),
      data,
    };

    // Notify specific listeners
    const typeListeners = this.listeners.get(type);
    if (typeListeners) {
      for (const cb of typeListeners) {
        try {
          cb(event);
        } catch (err) {
          console.error(`[HardwareEventBus] Listener error for ${type}:`, err);
        }
      }
    }

    // Notify global listeners
    for (const cb of this.globalListeners) {
      try {
        cb(event);
      } catch (err) {
        console.error('[HardwareEventBus] Global listener error:', err);
      }
    }

    // Bridge to DOM events for backward compatibility
    this.bridgeToDom(event);
  }

  /**
   * Backward-compatible bridge: also dispatch DOM events
   * so existing `pos:barcode_scanned` listeners still work
   */
  private bridgeToDom(event: HardwareEvent): void {
    if (event.type === 'scanner:barcode_scanned') {
      window.dispatchEvent(new CustomEvent('pos:barcode_scanned', {
        detail: event.data,
      }));
    }
  }

  /**
   * Remove all listeners (cleanup)
   */
  clear(): void {
    this.listeners.clear();
    this.globalListeners.clear();
  }
}

// Singleton
export const hardwareEventBus = new HardwareEventBusService();
