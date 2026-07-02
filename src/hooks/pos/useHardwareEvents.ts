/**
 * Hardware Events Hook — Subscribe to hardware event bus from React components.
 * 
 * Provides typed event subscriptions with automatic cleanup on unmount.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import {
  hardwareEventBus,
  type HardwareEventType,
  type HardwareEvent,
} from '@/services/hardware/HardwareEventBus';

/**
 * Subscribe to a specific hardware event type
 */
export function useHardwareEvent(
  eventType: HardwareEventType,
  callback: (event: HardwareEvent) => void,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    return hardwareEventBus.on(eventType, (event) => {
      callbackRef.current(event);
    });
  }, [eventType]);
}

/**
 * Subscribe to barcode scan events specifically
 */
export function useBarcodeScan(
  onScan: (barcode: string) => void,
): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    return hardwareEventBus.on('scanner:barcode_scanned', (event) => {
      const data = event.data as { barcode: string } | undefined;
      if (data?.barcode) {
        onScanRef.current(data.barcode);
      }
    });
  }, []);
}

/**
 * Subscribe to scale weight changes
 */
export function useScaleWeight(): {
  weight: number | null;
  unit: string;
  stable: boolean;
} {
  const [weight, setWeight] = useState<number | null>(null);
  const [unit, setUnit] = useState('kg');
  const [stable, setStable] = useState(false);

  useEffect(() => {
    const unsub1 = hardwareEventBus.on('scale:weight_changed', (event) => {
      const data = event.data as { weight: number; unit: string; stable: boolean } | undefined;
      if (data) {
        setWeight(data.weight);
        setUnit(data.unit);
        setStable(data.stable);
      }
    });

    const unsub2 = hardwareEventBus.on('scale:stable', (event) => {
      setStable(true);
      const data = event.data as { weight: number } | undefined;
      if (data) setWeight(data.weight);
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  return { weight, unit, stable };
}

/**
 * Subscribe to device discovery events
 */
export function useDeviceDiscovery(): {
  discoveredDevices: HardwareEvent[];
  clearDiscovered: () => void;
} {
  const [discoveredDevices, setDiscoveredDevices] = useState<HardwareEvent[]>([]);

  useEffect(() => {
    return hardwareEventBus.on('device:discovered', (event) => {
      setDiscoveredDevices(prev => [...prev, event]);
    });
  }, []);

  const clearDiscovered = useCallback(() => {
    setDiscoveredDevices([]);
  }, []);

  return { discoveredDevices, clearDiscovered };
}
