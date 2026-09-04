/**
 * Static Command Index Builder
 * 
 * Pure function — derives all `CommandEntry` objects from existing
 * registries (apps, reports, actions). Runs once at module load; result
 * is a frozen array reused across the lifetime of the page.
 * 
 * NEVER hard-code entries here. If you want a new page in the palette,
 * add it to APP_REGISTRY. If you want a new create action, add it to
 * ACTION_REGISTRY. The palette will pick it up automatically.
 */

import { LayoutGrid } from "lucide-react";
import { APP_REGISTRY, LEGACY_ROUTE_MAPPINGS } from "@/lib/apps/registry";
import { REPORT_REGISTRY } from "@/services/reports/ReportRegistry";
import { ACTION_REGISTRY } from "./actions";
import type { CommandEntry } from "./types";

/** Reverse map: full route → legacy aliases (e.g. "/sales/invoices" → ["invoices"]). */
function buildLegacyAliases(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [legacy, full] of Object.entries(LEGACY_ROUTE_MAPPINGS)) {
    if (!out.has(full)) out.set(full, []);
    // Strip leading slash, keep the path itself as a useful alias.
    out.get(full)!.push(legacy.replace(/^\//, ""));
  }
  return out;
}

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

function buildAppModuleEntries(): CommandEntry[] {
  const aliases = buildLegacyAliases();
  const out: CommandEntry[] = [];

  for (const app of APP_REGISTRY) {
    // Cache module-by-id lookup once per app so the default-module
    // resolution below is O(1) instead of an Array.find inside a loop.
    const modulesById = new Map(app.modules.map((m) => [m.id, m]));
    const defaultModulePath =
      modulesById.get(app.defaultModule)?.path ?? app.modules[0]?.path ?? "";

    // App-level "module" entry — jumps to default page.
    out.push({
      id: `module:${app.id}`,
      kind: "module",
      title: app.name,
      subtitle: "Open app",
      description: app.description,
      appId: app.id,
      icon: app.icon,
      keywords: normKeywords([app.id, app.name, ...app.description.split(/\s+/)]),
      weight: 60,
      to: `${app.basePath}${defaultModulePath}`,
      internalOnly: app.internalOnly,
      appInstall: app.alwaysAvailable ? undefined : app.id,
    });

    // Each module → a "page" entry.
    for (const mod of app.modules) {
      if (mod.hidden) continue;
      const fullPath = `${app.basePath}${mod.path}`;
      const legacy = aliases.get(fullPath) ?? [];
      out.push({
        id: `page:${app.id}/${mod.id}`,
        kind: "page",
        title: mod.name,
        subtitle: `${app.name} › ${mod.name}`,
        description: mod.description,
        appId: app.id,
        icon: mod.icon,
        keywords: normKeywords(
          [mod.name, app.name, mod.id, app.id],
          legacy,
          mod.description?.split(/\s+/) ?? [],
        ),
        weight: 70,
        to: fullPath,
        permission: mod.permission,
        featureFlag: mod.featureFlag,
        appInstall: app.alwaysAvailable ? undefined : app.id,
        internalOnly: app.internalOnly,
      });
    }
  }

  return out;
}

function buildReportEntries(): CommandEntry[] {
  return REPORT_REGISTRY.map((r) => ({
    id: `report:${r.id}`,
    kind: "report" as const,
    title: r.name,
    subtitle: "Report",
    description: r.description,
    appId: "finance",
    icon: r.icon,
    // Include category label so "financial statements" finds the leaves too.
    keywords: normKeywords([r.name, ...r.keywords, r.description, r.reportType]),
    weight: 55,
    to: r.path,
    permission: r.permission,
    appInstall: "finance",
    internalOnly: true,
  }));
}

function buildActionEntries(): CommandEntry[] {
  return ACTION_REGISTRY.map((a) => {
    // Map action category → most likely owning app for context boost.
    const appByCategory: Record<string, string> = {
      sales: "sales", purchases: "purchases", inventory: "inventory",
      accounting: "finance", hr: "hr",
      crm: "crm", contacts: "contacts",
    };
    const url = a.queryParams ? `${a.path}?${a.queryParams}` : a.path;
    return {
      id: `action:${a.id}`,
      kind: "action" as const,
      title: `Create ${a.label}`,
      subtitle: "Action",
      appId: appByCategory[a.category] ?? "platform",
      icon: a.icon,
      keywords: normKeywords(
        [a.label, "create", "new", "add", a.id],
        a.keywords ?? [],
      ),
      weight: 65,
      to: url,
      permission: a.permission,
      // permissionsAny is handled in filterAccessible by treating the
      // action as accessible if ANY listed permission is granted; we
      // store it under a dedicated field via a tiny extension below.
      ...(a.permissionsAny ? { __permissionsAny: a.permissionsAny } : {}),
      appInstall: a.appInstall,
      internalOnly: true,
    } as CommandEntry & { __permissionsAny?: string[] };
  });
}

let _index: readonly CommandEntry[] | null = null;

/** Build (or return cached) static index. Called automatically. */
export function getStaticCommandIndex(): readonly CommandEntry[] {
  if (_index) return _index;
  const all = [
    ...buildAppModuleEntries(),
    ...buildActionEntries(),
    ...buildReportEntries(),
  ];
  _index = Object.freeze(all);
  return _index;
}

/** Test-only: flush the memoised index. */
export function __resetStaticIndexForTests() {
  _index = null;
}
