/**
 * Cartesian product of selected axis values → variant coordinates.
 * Pure function, no I/O. Guarded by product-variants.test.ts.
 */
export interface AxisSelection {
  axisName: string;
  values: string[];
}

export type VariantCoordinate = Record<string, string>;

export function generateVariantMatrix(
  selections: AxisSelection[],
): VariantCoordinate[] {
  const filtered = selections.filter((s) => s.values.length > 0);
  if (filtered.length === 0) return [];

  return filtered.reduce<VariantCoordinate[]>(
    (acc, sel) => {
      if (acc.length === 0) {
        return sel.values.map((v) => ({ [sel.axisName]: v }));
      }
      const next: VariantCoordinate[] = [];
      for (const row of acc) {
        for (const v of sel.values) {
          next.push({ ...row, [sel.axisName]: v });
        }
      }
      return next;
    },
    [],
  );
}

/** Deterministic SKU suffix — parent SKU + "-" + slugified axis values in axis order. */
export function deriveVariantSku(
  parentSku: string | null | undefined,
  coord: VariantCoordinate,
): string {
  const suffix = Object.keys(coord)
    .sort()
    .map((k) => slug(coord[k]))
    .join("-");
  const base = (parentSku ?? "VAR").trim();
  return suffix ? `${base}-${suffix}` : base;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toUpperCase()
    .slice(0, 12);
}

/** Coord equality used to detect existing variants when regenerating. */
export function sameCoord(
  a: VariantCoordinate | null | undefined,
  b: VariantCoordinate | null | undefined,
): boolean {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}
