import { useCallback, useEffect, useState } from "react";
import {
  getPOSSoundPrefs,
  playPOSSound,
  setPOSSoundPrefs,
  subscribePOSSoundPrefs,
  type POSSoundEvent,
  type POSSoundPrefs,
} from "@/lib/pos/sounds";

/**
 * React binding for POS sound preferences.
 * Per-device (localStorage) — no DB writes.
 */
export function usePOSSound() {
  const [prefs, setPrefs] = useState<POSSoundPrefs>(() => getPOSSoundPrefs());

  useEffect(() => {
    const unsub = subscribePOSSoundPrefs(setPrefs);
    return () => {
      unsub();
    };
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    setPOSSoundPrefs({ enabled });
  }, []);

  const setVolume = useCallback((volume: number) => {
    setPOSSoundPrefs({ volume: Math.max(0, Math.min(1, volume)) });
  }, []);

  const toggle = useCallback(() => {
    setPOSSoundPrefs({ enabled: !getPOSSoundPrefs().enabled });
  }, []);

  const play = useCallback((event: POSSoundEvent) => {
    playPOSSound(event);
  }, []);

  return {
    enabled: prefs.enabled,
    volume: prefs.volume,
    setEnabled,
    setVolume,
    toggle,
    play,
  };
}
