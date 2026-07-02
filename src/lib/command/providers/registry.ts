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
import { invoicesProvider } from "./invoices";
import { billsProvider } from "./bills";
import { productsProvider } from "./products";
import { journalEntriesProvider } from "./journalEntries";

export const COMMAND_PROVIDERS: CommandProvider[] = [
  customersProvider,
  invoicesProvider,
  billsProvider,
  productsProvider,
  journalEntriesProvider,
];
