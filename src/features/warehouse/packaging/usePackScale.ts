/**
 * Pack-station scale seam (ADR 0105 §8, Phase 6).
 *
 * Sealing a carton needs a *trusted* weight: dim-weight billing, carrier
 * admissibility and 3PL invoicing all read `wms_pack_cartons.weight_kg`.
 * Typed weights are guesses, so the pack station reads the bound scale
 * through the existing hardware command router (`useHardwareProxy` → `resolve_device`
 * → `TransportRouter`) rather than talking to a driver or WebSerial directly
 * (ADR 0037 topology, ADR 0100 operator workspace).
 *
 * The hook normalises every driver payload shape to kilograms and reports
 * whether the reading was stable, so the UI can refuse an unstable weight.
 */
import { useCallback, useState } from "react";
import { useHardwareProxy } from "@/hooks/hardware/useHardwareProxy";

export interface ScaleWeight {
  kg: number;
  stable: boolean;
  unit: string;
  at: string;
}

const TO_KG: Record<string, number> = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.0283495231 };

/** Normalise any driver weight payload into kilograms. */
export function normalizeScaleWeight(data: unknown): ScaleWeight | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const rawUnit = typeof d.unit === "string" ? d.unit.toLowerCase() : "kg";
  let value: number | null = null;
  if (typeof d.weight === "number") value = d.weight;
  else if (typeof d.weight_kg === "number") value = d.weight_kg;
  else if (typeof d.grams === "number") return {
    kg: Number((d.grams / 1000).toFixed(3)),
    stable: d.stable !== false,
    unit: "g",
    at: new Date().toISOString(),
  };
  if (value === null || !Number.isFinite(value)) return null;
  const factor = TO_KG[rawUnit] ?? 1;
  return {
    kg: Number((value * factor).toFixed(3)),
    stable: d.stable !== false,
    unit: rawUnit,
    at: typeof d.timestamp === "string" ? d.timestamp : new Date().toISOString(),
  };
}

export function usePackScale(registerId?: string) {
  const { readScale, tareScale, hardwareStatus } = useHardwareProxy(registerId) as unknown as {
    readScale: () => Promise<{ success: boolean; error?: string; data?: unknown }>;
    tareScale: () => Promise<{ success: boolean; error?: string; data?: unknown }>;
    hardwareStatus?: Record<string, unknown>;
  };
  const [reading, setReading] = useState<ScaleWeight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (): Promise<ScaleWeight | null> => {
    setBusy(true);
    setError(null);
    try {
      const res = await readScale();
      if (!res.success) {
        setError(res.error ?? "Scale read failed");
        return null;
      }
      const weight = normalizeScaleWeight(res.data);
      if (!weight) {
        setError("Scale returned no usable weight");
        return null;
      }
      setReading(weight);
      return weight;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scale read failed");
      return null;
    } finally {
      setBusy(false);
    }
  }, [readScale]);

  const tare = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await tareScale();
      if (!res.success) setError(res.error ?? "Tare failed");
      return res.success;
    } finally {
      setBusy(false);
    }
  }, [tareScale]);

  return { reading, read, tare, busy, error, hardwareStatus };
}
