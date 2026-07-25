/**
 * Legal Order Packs — Phase 6 enterprise workspace tab.
 *
 * Read surface for the tenant→pack→platform resolution of garnishment
 * kind defaults. Renders each effective kind alongside its source
 * badge so operators can see, per organization:
 *
 *   • which kinds are inherited from the platform baseline,
 *   • which come from an installed localization pack, and
 *   • which have been overridden at tenant scope.
 *
 * Writers stay in the Statutory Rules / pack authoring flows; this
 * page is intentionally read-only. Backed by the security-invoker
 * view `public.legal_order_effective_kind_defaults` (Phase 6
 * migration).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface EffectiveKind {
  organization_id: string;
  kind: string;
  label: string | null;
  default_priority: number | null;
  always_first: boolean | null;
  counts_toward_aggregate_cap: boolean | null;
  max_concurrent: number | null;
  employer_fee_amount: number | null;
  required_identifiers: unknown;
  evidence_required: boolean | null;
  source: "tenant" | "pack" | "platform";
  source_pack_id: string | null;
  calc_model: string | null;
  priority_class: number | null;
  protected_earnings_rule: Record<string, unknown> | null;
  aggregate_cap_membership: string | null;
}

function sourceBadge(source: EffectiveKind["source"]) {
  switch (source) {
    case "tenant":
      return (
        <Badge variant="default" className="uppercase tracking-wide text-[10px]">
          Tenant override
        </Badge>
      );
    case "pack":
      return (
        <Badge variant="secondary" className="uppercase tracking-wide text-[10px]">
          Localization pack
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="uppercase tracking-wide text-[10px]">
          Platform default
        </Badge>
      );
  }
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function protectedEarnings(rule: Record<string, unknown> | null): string {
  if (!rule || Object.keys(rule).length === 0) return "—";
  if (typeof rule.min_pct_of_gross === "number") {
    return `min take-home ${fmtPct(rule.min_pct_of_gross as number)} of gross`;
  }
  if (typeof rule.min_amount === "number") {
    return `min take-home ${(rule.min_amount as number).toFixed(2)}`;
  }
  return JSON.stringify(rule);
}

export default function LegalOrderPacks() {
  const { currentOrg } = useOrganization();

  const { data, isLoading, error } = useQuery({
    queryKey: ["legal-order-effective-kinds", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<EffectiveKind[]> => {
      const { data, error } = await supabase
        .from("legal_order_effective_kind_defaults" as never)
        .select("*")
        .eq("organization_id", currentOrg!.id);
      if (error) throw error;
      return (data ?? []) as EffectiveKind[];
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    return [...data].sort(
      (a, b) =>
        (a.priority_class ?? 999) - (b.priority_class ?? 999) ||
        (a.default_priority ?? 999) - (b.default_priority ?? 999),
    );
  }, [data]);

  const summary = useMemo(() => {
    const counts = { tenant: 0, pack: 0, platform: 0 };
    for (const r of rows) counts[r.source]++;
    return counts;
  }, [rows]);

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 min-w-0">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Effective garnishment kinds</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Resolved with precedence <b>tenant override → localization
                pack → platform default</b>. Any change to a source
                appears here on the next resolve.
              </p>
            </div>
            <div className="flex gap-2">
              <Badge variant="default">{summary.tenant} tenant</Badge>
              <Badge variant="secondary">{summary.pack} pack</Badge>
              <Badge variant="outline">{summary.platform} platform</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}
          {error && (
            <div className="text-sm text-destructive">
              Failed to load effective kinds: {(error as Error).message}
            </div>
          )}
          {!isLoading && !error && rows.length === 0 && (
            <div className="text-sm text-muted-foreground">
              No garnishment kinds resolved for this organization.
            </div>
          )}
          {rows.length > 0 && (
            <TooltipProvider delayDuration={100}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Priority class</TableHead>
                    <TableHead>Aggregate cap</TableHead>
                    <TableHead>Calc model</TableHead>
                    <TableHead>Protected earnings</TableHead>
                    <TableHead>Employer fee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.kind}>
                      <TableCell>
                        <div className="font-medium">{r.label ?? r.kind}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.kind}
                        </div>
                      </TableCell>
                      <TableCell>{sourceBadge(r.source)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.priority_class ?? "—"}
                      </TableCell>
                      <TableCell>
                        {r.always_first ? (
                          <Tooltip>
                            <TooltipTrigger className="inline-flex items-center gap-1">
                              <Badge variant="destructive">Always first</Badge>
                              <Info className="h-3 w-3 text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent>
                              Withheld before the aggregate cap pool
                              (e.g. child support, maintenance).
                            </TooltipContent>
                          </Tooltip>
                        ) : r.counts_toward_aggregate_cap ? (
                          <Badge variant="secondary">In cap pool</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.calc_model ?? "fixed"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {protectedEarnings(r.protected_earnings_rule)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.employer_fee_amount
                          ? r.employer_fee_amount.toFixed(2)
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TooltipProvider>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">About this view</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Read-only. Values are computed by the
            <code className="mx-1 px-1 bg-muted rounded">
              garnishment_resolve_kinds
            </code>
            resolver: tenant overrides win, then the installed
            localization pack, then the platform baseline.
          </p>
          <p>
            To customize a value at tenant scope, use{" "}
            <b>Statutory Rules → Garnishment kinds</b>. To ship a
            jurisdiction-wide change, edit the localization pack (see
            ADR-0095).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
