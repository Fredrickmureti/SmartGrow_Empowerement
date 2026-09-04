/**
 * Provider Registry
 *
 * Central list of async record/AI providers. Adding a new provider is
 * a single push here — the palette hook picks it up automatically.
 *
 * Order matters: matches the visual group order under static results.
 */

import type { CommandProvider } from "./types";
import { customersProvider } from "./customers";
import { journalEntriesProvider } from "./journalEntries";

export const COMMAND_PROVIDERS: CommandProvider[] = [
  customersProvider,
  journalEntriesProvider,
];
