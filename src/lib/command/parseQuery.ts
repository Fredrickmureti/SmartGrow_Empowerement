/**
 * Command Palette — Smart Input Parser
 *
 * Translates the raw query into a `ParsedQuery` describing the user's
 * intent. Pure function; no React, no I/O.
 *
 * Supported shapes:
 *   ">foo"          → action scope, query "foo"
 *   "#1042"         → record scope, query "1042"
 *   "?"             → help mode (currently a no-op flag)
 *   "je 2025-001"   → record scope hinted to journal-entries
 *   "client acme"   → record scope hinted to clients
 *   anything else   → no scope, raw query passed through
 *
 * The numeric/alias hints are deliberately conservative — only fire
 * when the head token unambiguously names a record type. Misfires
 * silently degrade to a normal multi-provider search.
 */

import type { CommandKind } from "./types";

export interface ParsedQuery {
  /** The query string after stripping any prefix/alias. */
  text: string;
  /** Static-result kind filter, or null for all. */
  kindScope: CommandKind | null;
  /** Async-provider id filter, or null for all. */
  providerScope: string | null;
  /** Raw original input — used for telemetry. */
  raw: string;
  /** True when the user is in help mode (`?`). */
  help: boolean;
}

/** Token aliases → provider id. Keep narrow & unambiguous. */
const ALIAS_TO_PROVIDER: Record<string, string> = {
  client: "records:customers",
  clients: "records:customers",
  member: "records:customers",
  members: "records:customers",
  borrower: "records:customers",
  je: "records:journal-entries",
  journal: "records:journal-entries",
};

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { text: "", kindScope: null, providerScope: null, raw, help: false };
  }

  if (trimmed === "?") {
    return { text: "", kindScope: null, providerScope: null, raw, help: true };
  }

  if (trimmed.startsWith(">")) {
    return {
      text: trimmed.slice(1).trim(),
      kindScope: "action",
      providerScope: null,
      raw,
      help: false,
    };
  }

  if (trimmed.startsWith("#")) {
    return {
      text: trimmed.slice(1).trim(),
      kindScope: "record",
      providerScope: null,
      raw,
      help: false,
    };
  }

  // Alias hint: "<alias> <rest>" where alias is a known noun and rest
  // is non-empty. The bare alias on its own falls through to normal
  // search so users still see the matching page entry.
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx > 0) {
    const head = trimmed.slice(0, spaceIdx).toLowerCase();
    const tail = trimmed.slice(spaceIdx + 1).trim();
    const provider = ALIAS_TO_PROVIDER[head];
    if (provider && tail.length > 0) {
      return {
        text: tail,
        kindScope: "record",
        providerScope: provider,
        raw,
        help: false,
      };
    }
  }

  return { text: trimmed, kindScope: null, providerScope: null, raw, help: false };
}
