/**
 * Reports navigation — derived from the report registry, never hand-written.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Finance sidebar and the standalone `/reports` sidebar each used to carry
 * their own hardcoded list of report links. They drifted from
 * `REPORT_REGISTRY`: FX Revaluation, FX Exposure, Bank reconciliation, the two
 * integrity reconciliations and the stock reports were registered, routed and
 * reachable by search, but invisible in the sidebar.
 *
 * Same rule as ADR-0062 for payroll reports: the navigation is registry-driven.
 * Add a registry row → the link appears. There is no second list to maintain.
 *
 * GROUPING
 * --------
 * A flat list of 24 reports is a chip wall. Enterprise finance suites group the
 * report catalogue by accounting family (statements → ledgers → subledgers →
 * cash → currency → tax → planning → inventory → integrity → analytics), which
 * is what {@link REPORT_FAMILIES} encodes. Invariants:
 *   - every finance report belongs to exactly ONE family (guarded by test);
 *   - reports of the same family never appear as siblings of their family;
 *   - child views of a hub report (P&L / Balance sheet) hang off the hub, not
 *     off the family;
 *   - module-owned reports (HR, Payroll, POS, Projects, Timesheets) are NOT
 *     included — those modules own their own navigation.
 */
import {
  FileText,
  BookOpen,
  Users,
  Wallet,
  Coins,
  Receipt,
  Target,
  Boxes,
  ShieldCheck,
  BarChart3,
  type LucideIcon,
} from "lucide-react";

import type { WorkspaceNavItem } from "@/components/layout/shell/types";
import { REPORT_REGISTRY, type ReportDefinition } from "./ReportRegistry";

export interface ReportFamily {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Registry ids, in display order. Ids that do not exist are ignored. */
  reportIds: string[];
}

/** The finance report catalogue, grouped by accounting family. */
export const REPORT_FAMILIES: ReportFamily[] = [
  {
    key: "statements",
    label: "Financial statements",
    icon: FileText,
    reportIds: ["financial-statements"],
  },
  {
    key: "ledgers",
    label: "Ledgers & journals",
    icon: BookOpen,
    reportIds: ["trial-balance", "general-ledger", "journal-report"],
  },
  {
    key: "subledgers",
    label: "Receivables & payables",
    icon: Users,
    reportIds: ["aged-receivables", "aged-payables", "partner-ledger", "sales-reports"],
  },
  {
    key: "cash",
    label: "Cash & banking",
    icon: Wallet,
    reportIds: ["cash-flow", "bank-reconciliation-report"],
  },
  {
    key: "fx",
    label: "Currency & FX",
    icon: Coins,
    reportIds: ["fx-revaluation", "fx-exposure"],
  },
  {
    key: "tax",
    label: "Tax & compliance",
    icon: Receipt,
    reportIds: ["tax-reports"],
  },
  {
    key: "planning",
    label: "Budget & assets",
    icon: Target,
    reportIds: ["budget-report", "depreciation-report"],
  },
  {
    key: "inventory",
    label: "Inventory",
    icon: Boxes,
    // Dual-host family (ADR 0143): the SAME eight reports are listed by the
    // Finance sidebar and by the Inventory sidebar; only the URL prefix
    // differs, so a click never throws the user into the other app.
    reportIds: [
      "stock-reports",
      "inventory-valuation",
      "stock-ledger",
      "stock-aging",
      "lot-traceability",
      "stock-adjustments-report",
      "stock-transfers-report",
      "inventory-gl-reconciliation",
    ],
  },
  {
    key: "integrity",
    label: "Audit & integrity",
    icon: ShieldCheck,
    reportIds: [
      "audit-trail",
      "report-run-history",
      "control-account-reconciliation",
      // inventory-gl-reconciliation now lives in the `inventory` family
      // (one family per report — see test guard).
    ],
  },
  {
    key: "analytics",
    label: "Analytics",
    icon: BarChart3,
    reportIds: ["management-reports", "business-intelligence"],
  },
];

/** Finance-owned reports: routed under `/finance/reports/…`. */
export function getFinanceReportDefinitions(): ReportDefinition[] {
  return REPORT_REGISTRY.filter((r) => r.path.startsWith("/finance/reports/"));
}

/** Ids that a family claims as a hub child (e.g. P&L under Financial statements). */
function childrenOf(def: ReportDefinition): ReportDefinition[] {
  return REPORT_REGISTRY.filter((r) => r.parentId === def.id);
}

export type ReportHost = "finance" | "inventory";

/**
 * Resolve the URL for a report inside the shell the user is currently in.
 * Inventory reports are mounted under both `/finance/reports/*` and
 * `/inventory-app/reports/*`; every other report has a single mount.
 */
export function resolveReportPath(
  def: Pick<ReportDefinition, "path" | "paths">,
  pathnameOrHost: string,
): string {
  if (!def.paths) return def.path;
  const host: ReportHost = pathnameOrHost === "inventory" ||
    pathnameOrHost.startsWith("/inventory-app")
    ? "inventory"
    : "finance";
  return def.paths[host];
}

function toNavItems(def: ReportDefinition, host: ReportHost = "finance"): WorkspaceNavItem[] {
  const hub: WorkspaceNavItem = {
    to: resolveReportPath(def, host),
    label: def.name,
    icon: def.icon,
    permission: def.permission,
    end: true,
  };
  // Hub views (P&L / Balance sheet) share the hub route with a query string,
  // so they render as siblings inside the family rather than as a nested
  // folder — the sidebar turns any item with children into a non-clickable
  // disclosure, which would make the hub itself unreachable.
  return [hub, ...childrenOf(def).map((k) => ({
    to: resolveReportPath(k, host),
    label: k.name,
    icon: k.icon,
    permission: k.permission,
    end: true as const,
  }))];
}

/**
 * The `Reports` sub-tree: one collapsible node per family, each holding its
 * reports.
 */
export function buildReportsNavChildren(host: ReportHost = "finance"): WorkspaceNavItem[] {
  const byId = new Map(REPORT_REGISTRY.map((r) => [r.id, r]));
  const items: WorkspaceNavItem[] = [];

  for (const family of REPORT_FAMILIES) {
    const children = family.reportIds
      .map((id) => byId.get(id))
      .filter((d): d is ReportDefinition => Boolean(d))
      .flatMap((d) => toNavItems(d, host));
    if (children.length === 0) continue;

    // A single-report family is noise as a folder — surface the report itself.
    if (children.length === 1) {
      items.push({ ...children[0], icon: family.icon });
      continue;
    }
    items.push({ label: family.label, icon: family.icon, children });
  }

  return items;
}

/** Flat list of every finance report path reachable from the built nav. */
export function collectNavReportPaths(items: WorkspaceNavItem[]): string[] {
  const out: string[] = [];
  const walk = (list: WorkspaceNavItem[]) => {
    for (const i of list) {
      if (i.to) out.push(i.to);
      if (i.children?.length) walk(i.children);
    }
  };
  walk(items);
  return out;
}


/**
 * The Inventory app's Insights group — the SAME registry family as the Finance
 * sidebar, emitted with `/inventory-app/...` URLs. Never hand-list inventory
 * reports in `src/apps/inventory/nav.ts`; add a registry row instead.
 */
export function buildInventoryReportsNavChildren(): WorkspaceNavItem[] {
  const byId = new Map(REPORT_REGISTRY.map((r) => [r.id, r]));
  const family = REPORT_FAMILIES.find((f) => f.key === "inventory");
  if (!family) return [];
  return family.reportIds
    .map((id) => byId.get(id))
    .filter((d): d is ReportDefinition => Boolean(d))
    .flatMap((d) => toNavItems(d, "inventory"));
}
