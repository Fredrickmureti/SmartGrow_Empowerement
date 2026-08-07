/**
 * ReversalRegister (ADR 0129, Phase 5.4)
 *
 * One period-scoped finance surface answering "what was reversed, why, by whom,
 * for how much, and was it approved?" across sales, purchases, receiving, POS
 * and payroll. It reads the canonical `public.reversal_register` view — it never
 * re-derives reversal state per module, because a screen-local union would drift
 * from the writers.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { History, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useReversalRegister } from "@/hooks/useReversalRegister";
import {
  REVERSAL_MODULE_LABELS,
  REVERSIBLE_DOCUMENTS,
  documentLabel,
  type ReversalModule,
} from "@/services/reversal/registerModules";

const ALL = "__all__";

const startOfCurrentMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
};

const today = () => new Date().toISOString().slice(0, 10);

const kindVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  void: "destructive",
  reversal: "destructive",
  return: "outline",
  correction: "secondary",
};

export default function ReversalRegister() {
  const { currentOrg } = useOrganization();
  const [from, setFrom] = useState(startOfCurrentMonth);
  const [to, setTo] = useState(today);
  const [moduleFilter, setModuleFilter] = useState<string>(ALL);
  const [documentTypeFilter, setDocumentTypeFilter] = useState<string>(ALL);
  const [reasonFilter, setReasonFilter] = useState<string>(ALL);

  const { entries, isLoading, error, refetch } = useReversalRegister({
    organizationId: currentOrg?.id ?? null,
    from,
    to,
    module: moduleFilter === ALL ? null : moduleFilter,
    documentType: documentTypeFilter === ALL ? null : documentTypeFilter,
    reasonCode: reasonFilter === ALL ? null : reasonFilter,
  });

  const { data: reasonCodes } = useQuery({
    queryKey: ["reversal-reason-codes", "all"],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error: err } = await supabase
        .from("reversal_reason_codes" as any)
        .select("code, label")
        .order("sort_order", { ascending: true });
      if (err) throw err;
      return (data ?? []) as unknown as Array<{ code: string; label: string }>;
    },
  });

  const reasonLabel = (code: string | null) =>
    code ? reasonCodes?.find((r) => r.code === code)?.label ?? code : "—";

  const actorIds = useMemo(
    () => Array.from(new Set(entries.map((e) => e.reversed_by).filter(Boolean) as string[])),
    [entries],
  );

  const { data: actors } = useQuery({
    queryKey: ["reversal-register-actors", actorIds],
    enabled: actorIds.length > 0,
    queryFn: async () => {
      const { data, error: err } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", actorIds);
      if (err) throw err;
      return data ?? [];
    },
  });

  const actorName = (id: string | null) => {
    if (!id) return "—";
    const a = actors?.find((p: any) => p.user_id === id);
    return a?.full_name || a?.email || id.slice(0, 8);
  };

  const totalsByModule = useMemo(() => {
    const m = new Map<string, { count: number; amount: number }>();
    for (const e of entries) {
      const cur = m.get(e.module) ?? { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += Number(e.amount ?? 0);
      m.set(e.module, cur);
    }
    return Array.from(m.entries());
  }, [entries]);

  const documentTypeOptions = useMemo(
    () =>
      REVERSIBLE_DOCUMENTS.filter(
        (d) => moduleFilter === ALL || d.module === moduleFilter,
      ),
    [moduleFilter],
  );

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <History className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Reversal register</h1>
            <p className="text-sm text-muted-foreground">
              Every reversed document in the period, across all modules, with its
              reason and approval trail.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RotateCcw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Period and filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="rr-from">From</Label>
            <Input
              id="rr-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rr-to">To</Label>
            <Input
              id="rr-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rr-module">Module</Label>
            <Select
              value={moduleFilter}
              onValueChange={(v) => {
                setModuleFilter(v);
                setDocumentTypeFilter(ALL);
              }}
            >
              <SelectTrigger id="rr-module">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All modules</SelectItem>
                {(Object.keys(REVERSAL_MODULE_LABELS) as ReversalModule[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {REVERSAL_MODULE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rr-doc">Document</Label>
            <Select value={documentTypeFilter} onValueChange={setDocumentTypeFilter}>
              <SelectTrigger id="rr-doc">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All documents</SelectItem>
                {documentTypeOptions.map((d) => (
                  <SelectItem key={d.documentType} value={d.documentType}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rr-reason">Reason</Label>
            <Select value={reasonFilter} onValueChange={setReasonFilter}>
              <SelectTrigger id="rr-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All reasons</SelectItem>
                {(reasonCodes ?? []).map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {totalsByModule.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {totalsByModule.map(([mod, t]) => (
            <Card key={mod}>
              <CardHeader className="pb-2">
                <CardDescription>
                  {REVERSAL_MODULE_LABELS[mod as ReversalModule] ?? mod}
                </CardDescription>
                <CardTitle className="text-xl">{t.count}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 text-sm text-muted-foreground">
                {t.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} reversed
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reversals</CardTitle>
          <CardDescription>
            {isLoading ? "Loading…" : `${entries.length} entries`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p className="text-sm text-destructive">{error.message}</p>
          )}
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No reversals recorded in this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Module</TableHead>
                    <TableHead>Document</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Doc date</TableHead>
                    <TableHead>Reversed</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Approval</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <TableRow key={`${e.document_type}-${e.document_id}`}>
                      <TableCell>
                        {REVERSAL_MODULE_LABELS[e.module as ReversalModule] ?? e.module}
                      </TableCell>
                      <TableCell>{documentLabel(e.document_type)}</TableCell>
                      <TableCell className="font-medium">
                        {e.document_number ?? "—"}
                      </TableCell>
                      <TableCell>{e.document_date?.slice(0, 10) ?? "—"}</TableCell>
                      <TableCell>{e.reversal_date?.slice(0, 10) ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {e.amount === null
                          ? "—"
                          : `${Number(e.amount).toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            })}${e.currency ? ` ${e.currency}` : ""}`}
                      </TableCell>
                      <TableCell>
                        <Badge variant={kindVariant[e.reversal_kind ?? ""] ?? "outline"}>
                          {e.reversal_kind ?? "—"}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[18rem]">
                        <div className="truncate">{reasonLabel(e.reason_code)}</div>
                        {e.reason_comment && (
                          <div className="truncate text-xs text-muted-foreground">
                            {e.reason_comment}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{actorName(e.reversed_by)}</TableCell>
                      <TableCell>
                        {e.approval_request_id ? (
                          <Badge variant="secondary">{e.approval_status ?? "requested"}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not required</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
