/**
 * Static Command Index Builder — Platform Admin
 *
 * Mirrors `buildAppModuleEntries()` in `buildIndex.ts`, but emits
 * entries tagged `surface: "platform"` and `internalOnly: true`.
 *
 * Entries are gated by `useCommandPalette` to platform admins only;
 * route guards still independently enforce access.
 *
 * NEVER hard-code admin pages here. Add them to
 * `src/lib/admin/registry.ts` and they appear automatically.
 */

import { Shield } from "lucide-react";
import {
  PLATFORM_ADMIN_REGISTRY,
  PLATFORM_ADMIN_BASE,
} from "@/lib/admin/registry";
import type { CommandEntry } from "./types";

/** Lowercase + dedupe + drop empties. */
function normKeywords(...lists: (string | undefined)[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      if (!raw) continue;
      const k = raw.toLowerCase().trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

export function buildPlatformAdminEntries(): CommandEntry[] {
  const out: CommandEntry[] = [];

  // Top-level "Platform Admin" module entry — quick jump to the console.
  out.push({
    id: "module:platform-admin",
    kind: "module",
    title: "Platform Admin",
    subtitle: "Open admin console",
    description: "Manage the entire platform",
    appId: "platform-admin",
    icon: Shield,
    keywords: normKeywords([
      "platform",
      "admin",
      "console",
      "operator",
      "ops",
      "saas",
      "back office",
    ]),
    weight: 75,
    to: PLATFORM_ADMIN_BASE,
    surface: "platform",
    internalOnly: true,
  });

  for (const entry of PLATFORM_ADMIN_REGISTRY) {
    const fullPath = `${PLATFORM_ADMIN_BASE}${entry.path}`;
    out.push({
      id: `page:platform-admin/${entry.id}`,
      kind: "page",
      title: entry.name,
      subtitle: `Platform Admin › ${entry.name}`,
      description: entry.description,
      appId: "platform-admin",
      icon: entry.icon,
      keywords: normKeywords(
        [entry.name, entry.id, "admin", "platform"],
        entry.keywords ?? [],
        entry.description?.split(/\s+/) ?? [],
      ),
      weight: entry.weight ?? 70,
      to: fullPath,
      surface: "platform",
      internalOnly: true,
    });
  }

  return out;
}
