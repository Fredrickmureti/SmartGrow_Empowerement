/**
 * Scan guidance vocabulary (Phase 4.2).
 *
 * "Listening" is a machine state. An operator holding a pallet needs an
 * instruction: *what* to scan next, and what happens when they do. This
 * module is the single place that turns a mounted intent into operator
 * copy, so no screen ships its own string literal and no two screens word
 * the same prompt differently.
 *
 * Copy is derived from the intent, which the router already knows (targets
 * are registered with the label `wms:<intent>`), so the guidance surface
 * needs no prop plumbing through the screens.
 */
import type { WmsScanIntent } from "./wmsScanIntent";
import type { ScanEvent } from "@/services/pos/scanBus";

export interface ScanPrompt {
  /** Imperative instruction: "Scan the destination bin". */
  what: string;
  /** What happens on a good scan — the "and then?" half. */
  then: string;
}

const PROMPTS: Record<WmsScanIntent, ScanPrompt> = {
  "receiving.lpn":        { what: "Scan a pallet or LPN label",        then: "Opens it for unloading" },
  "receiving.item":       { what: "Scan an item barcode",              then: "Captures it against its expected line" },
  "putaway.bin":          { what: "Scan the destination bin",          then: "Confirms the put" },
  "putaway.lpn":          { what: "Scan the pallet you are putting away", then: "Loads its contents" },
  "pick.location":        { what: "Scan the pick location",            then: "Confirms you are at the right face" },
  "pick.item":            { what: "Scan the item you picked",          then: "Confirms the pick line" },
  "pack.carton":          { what: "Scan the carton label",             then: "Seals the carton" },
  "load.lpn":             { what: "Scan a carton or pallet label",     then: "Loads it onto the manifest" },
  "count.location":       { what: "Scan the location you are counting", then: "Opens its count sheet" },
  "count.item":           { what: "Scan an item",                      then: "Adds one to the counted quantity" },
  "qc.lpn":               { what: "Scan the pallet under inspection",  then: "Opens its inspection" },
  "qc.item":              { what: "Scan the item under inspection",    then: "Unlocks the verdict buttons" },
  "returns.item":         { what: "Scan the returned item",            then: "Adds it to the return" },
  "returns.lpn":          { what: "Scan the return pallet",            then: "Opens its contents" },
  "replen.source_location": { what: "Scan the source bin",             then: "Confirms the pull location" },
  "replen.lpn":           { what: "Scan the pallet to move",           then: "Loads it for replenishment" },
  "replen.item":          { what: "Scan the item",                     then: "Confirms what is moving" },
  "replen.destination":   { what: "Scan the pick face",                then: "Completes the replenishment" },
  "gate.pass":            { what: "Scan the gate pass or trailer plate", then: "Opens the matching appointment" },
  "yard.trailer":         { what: "Scan the trailer plate",            then: "Selects the trailer to move" },
  "yard.slot":            { what: "Scan the destination slot or dock", then: "Confirms the yard move" },
};

/** Router labels are `wms:<intent>`; recover the intent from one. */
export function intentFromTargetLabel(label: string | null | undefined): WmsScanIntent | null {
  if (!label || !label.startsWith("wms:")) return null;
  const candidate = label.slice(4) as WmsScanIntent;
  return candidate in PROMPTS ? candidate : null;
}

export function promptForIntent(intent: WmsScanIntent | null): ScanPrompt | null {
  return intent ? PROMPTS[intent] : null;
}

/** Operator-facing name for the input that is actually live. */
export function describeScanSource(source: ScanEvent["source"] | null | undefined): string {
  switch (source) {
    case "camera":   return "This device's camera";
    case "phone":    return "Paired phone";
    case "keyboard": return "Scanner gun";
    case "hardware": return "Connected scanner";
    case "serial":   return "Serial scanner";
    case "manual":   return "Typed by hand";
    default:         return "Waiting for a scanner";
  }
}

/**
 * Outcome taxonomy (Phase 4.3). `scanFeedbackBus` speaks in bus kinds; the
 * operator needs the four states that change what they do next.
 */
export type ScanVerdict = "accepted" | "duplicate" | "wrong_kind" | "unknown";

export function verdictCopy(verdict: ScanVerdict): string {
  switch (verdict) {
    case "accepted":   return "Accepted";
    case "duplicate":  return "Already scanned";
    case "wrong_kind": return "Wrong kind of label";
    case "unknown":    return "Not recognised";
  }
}

/**
 * Classify a feedback event into the operator taxonomy. Detail copy is the
 * only signal the bus carries for duplicate vs wrong-kind, and both are
 * produced by our own gates (`gateEntityToken`, the duplicate refusals in
 * dispatch/pack), so the wording is ours to match.
 */
export function classifyFeedback(kind: string, detail?: string): ScanVerdict {
  if (kind === "ok" || kind === "weighted") return "accepted";
  const d = (detail ?? "").toLowerCase();
  if (/already|duplicate/.test(d)) return "duplicate";
  if (/instead|wrong kind|not a /.test(d)) return "wrong_kind";
  return "unknown";
}
