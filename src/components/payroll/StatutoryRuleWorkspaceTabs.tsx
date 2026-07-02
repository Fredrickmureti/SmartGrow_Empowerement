/**
 * StatutoryRuleWorkspaceTabs — read-only panels that surface the
 * legislative lifecycle already implemented in the backend (pack upgrade
 * proposals, rule-level conflicts, audit log, effective-date timeline).
 *
 * The actual upgrade-apply and rollback actions continue to live in their
 * existing edge functions; these panels are the unified read-side
 * cockpit. Linking to the admin localization page for "Apply" keeps the
 * destructive action where the existing dual-control gates already are.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, GitPullRequest, AlertTriangle, History, Clock } from "lucide-react";
import { format } from "date-fns";
import {
  usePendingUpgradeProposals,
  useStatutoryRuleConflicts,
  useStatutoryRuleAuditLog,
  useStatutoryRuleStatus,
  type StatutoryRuleStatus,
} from "@/hooks/usePayrollStatutoryRuleStatus";

// ────────────────────────────────────────────────────────────────────────
// Upgrade inbox

export function UpgradeInboxPanel({ orgId }: { orgId: string | undefined }) {
  const { data, isLoading } = usePendingUpgradeProposals(orgId);
  const proposals = data ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (proposals.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-10">
          <GitPullRequest className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-base font-medium">No pending upgrades</h3>
          <p className="text-sm text-muted-foreground">
            Your installed packs are on the latest published version available to you.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {proposals.map((p: any) => {
        const ruleChanges = Array.isArray(p.diff?.payroll_statutory_rules)
          ? p.diff.payroll_statutory_rules.length
          : 0;
        return (
          <Card key={p.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <GitPullRequest className="h-4 w-4 text-sky-600" />
                <span>Upgrade to v{p.to_version}</span>
                <Badge variant="outline" className="text-xs">from v{p.from_version}</Badge>
                {ruleChanges > 0 ? (
                  <Badge variant="secondary" className="text-xs">
                    {ruleChanges} rule change{ruleChanges === 1 ? "" : "s"}
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription className="text-xs">
                Proposed {format(new Date(p.created_at), "MMM d, yyyy · HH:mm")}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Review the diff and apply from the Localization workspace. The apply path
                preserves your tenant overrides and records every per-rule decision in the
                audit log.
              </p>
              <Button asChild variant="outline" size="sm">
                <a href={`/hr/payroll/configuration/localization?proposal=${p.id}`}>
                  Review &amp; apply
                </a>
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Conflicts

const CONFLICT_TONE: Record<string, string> = {
  conflict: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-800",
  rollback_blocked: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-800",
  auto_merged: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800",
  tenant_kept: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800",
};

export function ConflictsPanel({ orgId }: { orgId: string | undefined }) {
  const { data, isLoading } = useStatutoryRuleConflicts(orgId);
  const conflicts = data ?? [];
  const [showResolved, setShowResolved] = useState(false);
  const visible = useMemo(
    () =>
      conflicts.filter((c: any) =>
        showResolved ? true : c.status === "conflict" || c.status === "rollback_blocked",
      ),
    [conflicts, showResolved],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (conflicts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-10">
          <AlertTriangle className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-base font-medium">No conflicts on record</h3>
          <p className="text-sm text-muted-foreground">
            Pack upgrades have not clashed with any local changes here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {visible.length} of {conflicts.length} conflict row{conflicts.length === 1 ? "" : "s"}
        </p>
        <Button variant="ghost" size="sm" onClick={() => setShowResolved((s) => !s)}>
          {showResolved ? "Show unresolved only" : "Show resolved too"}
        </Button>
      </div>
      <div className="space-y-2">
        {visible.map((c: any) => (
          <Card key={c.id}>
            <CardContent className="py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{c.rule_code}</code>
                <Badge variant="outline" className={`text-xs ${CONFLICT_TONE[c.status] ?? ""}`}>
                  {c.status}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  v{c.from_version} → v{c.to_version}
                </Badge>
                <span className="text-xs text-muted-foreground ml-auto">
                  {format(new Date(c.created_at), "MMM d, yyyy")}
                </span>
              </div>
              {c.resolution_notes ? (
                <p className="text-xs text-muted-foreground italic">{c.resolution_notes}</p>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Audit log

const AUDIT_TONE: Record<string, string> = {
  insert: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800",
  update: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800",
  delete: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-800",
};

export function AuditPanel({ orgId }: { orgId: string | undefined }) {
  const { data, isLoading } = useStatutoryRuleAuditLog(orgId, 100);
  const entries = data ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-10">
          <History className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-base font-medium">No audit entries yet</h3>
          <p className="text-sm text-muted-foreground">
            Statutory-rule writes are appended to the immutable pack audit log.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((e: any) => (
        <Card key={e.id}>
          <CardContent className="py-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={`text-xs ${AUDIT_TONE[e.action] ?? ""}`}>
                {e.action}
              </Badge>
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                {e.entity_id?.slice?.(0, 8) ?? "—"}
              </code>
              {e.metadata?.rule_code ? (
                <span className="text-xs text-muted-foreground">
                  {String(e.metadata.rule_code)}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground ml-auto">
                {format(new Date(e.created_at), "MMM d, yyyy · HH:mm")}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Timeline (grouped by rule_code)

export function TimelinePanel({ orgId }: { orgId: string | undefined }) {
  const { data, isLoading } = useStatutoryRuleStatus(orgId);
  const rules = data ?? [];

  const byCode = useMemo(() => {
    const map: Record<string, StatutoryRuleStatus[]> = {};
    for (const r of rules) {
      const key = `${r.country_code}::${r.rule_code ?? r.rule_type}`;
      if (!map[key]) map[key] = [];
      map[key].push(r);
    }
    // Sort each group by effective_from ASC.
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    }
    return map;
  }, [rules]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      {Object.entries(byCode).map(([key, versions]) => {
        const [country, code] = key.split("::");
        return (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <code className="text-sm">{code}</code>
                <Badge variant="outline" className="text-xs">{country}</Badge>
                <span className="text-xs text-muted-foreground ml-auto">
                  {versions.length} version{versions.length === 1 ? "" : "s"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative border-l border-border ml-3 space-y-3 py-1">
                {versions.map((v) => {
                  const isCurrent =
                    v.is_active &&
                    v.effective_from <= today &&
                    (!v.effective_to || v.effective_to >= today) &&
                    !v.superseded_by;
                  const isScheduled = v.effective_from > today;
                  const dotTone = isCurrent
                    ? "bg-emerald-500"
                    : isScheduled
                      ? "bg-sky-500"
                      : "bg-muted-foreground/40";
                  return (
                    <li key={v.rule_id} className="ml-4">
                      <span
                        className={`absolute -left-1.5 h-3 w-3 rounded-full ring-2 ring-background ${dotTone}`}
                      />
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="font-medium">{v.rule_name}</span>
                        {isCurrent ? (
                          <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800">
                            Current
                          </Badge>
                        ) : isScheduled ? (
                          <Badge variant="outline" className="text-[10px] bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800">
                            Scheduled
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Superseded
                          </Badge>
                        )}
                        {v.is_tenant_override ? (
                          <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800">
                            Override
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {v.effective_from} → {v.effective_to ?? "ongoing"}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
        );
      })}
      {Object.keys(byCode).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10">
            <Clock className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-base font-medium">No rules to plot yet</h3>
            <p className="text-sm text-muted-foreground">
              Install a localization pack to populate the legislative timeline.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
