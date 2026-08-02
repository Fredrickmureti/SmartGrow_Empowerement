/**
 * Warehouse vocabulary — business language for the location hierarchy.
 *
 * Operators do not think in "structure levels" or "child nodes"; they think
 * in zones, aisles, racks, shelves and bins. Every user-visible string for a
 * location level comes from here so the workspace never leaks schema
 * terminology into the UI.
 */
import type { StructureLevel } from "./types";

export const LEVEL_ORDER: StructureLevel[] = [
  "zone",
  "aisle",
  "rack",
  "shelf",
  "bin",
  "dock",
  "staging_in",
  "staging_out",
];

interface LevelVocabulary {
  singular: string;
  plural: string;
  /** What a supervisor calls the act of creating these. */
  addOne: string;
  addMany: string;
  /** One-line description shown in pickers. */
  hint: string;
  /** Default code prefix used by the builder. */
  prefix: string;
}

export const LEVEL: Record<StructureLevel, LevelVocabulary> = {
  zone: {
    singular: "Zone",
    plural: "Zones",
    addOne: "Add a zone",
    addMany: "Add zones",
    hint: "A area of the warehouse — Ambient, Cold chain, Bulk, Returns.",
    prefix: "Z",
  },
  aisle: {
    singular: "Aisle",
    plural: "Aisles",
    addOne: "Add an aisle",
    addMany: "Add aisles to this zone",
    hint: "A walkway between racking runs.",
    prefix: "A",
  },
  rack: {
    singular: "Rack",
    plural: "Racks",
    addOne: "Add a rack",
    addMany: "Add racks to this aisle",
    hint: "A bay of racking along an aisle.",
    prefix: "R",
  },
  shelf: {
    singular: "Shelf",
    plural: "Shelves",
    addOne: "Add a shelf",
    addMany: "Add shelves to this rack",
    hint: "A horizontal level within a rack.",
    prefix: "L",
  },
  bin: {
    singular: "Bin",
    plural: "Bins",
    addOne: "Add a bin",
    addMany: "Add bins to this shelf",
    hint: "The smallest pickable position — stock lives here.",
    prefix: "B",
  },
  dock: {
    singular: "Dock",
    plural: "Docks",
    addOne: "Add a dock",
    addMany: "Add docks",
    hint: "A door where trailers load and unload.",
    prefix: "D",
  },
  staging_in: {
    singular: "Inbound staging",
    plural: "Inbound staging areas",
    addOne: "Add inbound staging",
    addMany: "Add inbound staging areas",
    hint: "Where received goods wait for put-away.",
    prefix: "IN",
  },
  staging_out: {
    singular: "Outbound staging",
    plural: "Outbound staging areas",
    addOne: "Add outbound staging",
    addMany: "Add outbound staging areas",
    hint: "Where picked orders wait for loading.",
    prefix: "OUT",
  },
};

/** Levels a supervisor may create directly under a given parent level. */
export function childLevels(parent: StructureLevel | null): StructureLevel[] {
  switch (parent) {
    case null:
      return ["zone", "dock", "staging_in", "staging_out"];
    case "zone":
      return ["aisle", "dock", "staging_in", "staging_out"];
    case "aisle":
      return ["rack", "bin"];
    case "rack":
      return ["shelf", "bin"];
    case "shelf":
      return ["bin"];
    case "dock":
    case "staging_in":
    case "staging_out":
      return ["bin"];
    default:
      return [];
  }
}

export function levelLabel(level: StructureLevel | null | undefined): string {
  return level ? LEVEL[level].singular : "Location";
}

/** Human phrase for the "add" action under a given parent. */
export function addActionLabel(parent: StructureLevel | null): string {
  const next = childLevels(parent)[0];
  return next ? LEVEL[next].addMany : "Add location";
}

export const STATE_COPY: Record<string, { label: string; hint: string }> = {
  blocked: { label: "Blocked", hint: "Switched off — nothing may be put here." },
  full: { label: "Full", hint: "At or above 95% of its capacity." },
  busy: { label: "Activity", hint: "Warehouse work is open against this location." },
  stocked: { label: "Holding stock", hint: "Stock is on hand here." },
  empty: { label: "Empty", hint: "No stock, no open work." },
};
