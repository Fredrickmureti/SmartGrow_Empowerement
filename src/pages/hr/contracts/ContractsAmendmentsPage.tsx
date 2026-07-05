/**
 * ContractsAmendmentsPage — timeline of `contract_amendments` for the
 * active business, filterable by kind. Doubles as the Audit surface (with
 * different filter defaults).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, formatDistanceToNow } from "date-fns";
import { Loader2, Inbox, ExternalLink, Search, Filter } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader, PageBody } from "@/design-system";
import {
  useContractAmendments,
  AMENDMENT_KIND_LABELS,
  amendmentKindTone,
  type ContractAmendmentKind,
} from "@/hooks/hr/useContractAmendments";

interface Props {
  eyebrow: string;
  title: string;
  description: string;
  /** Restrict the queue to specific kinds (Renewals page passes ['renewal']). */
  kinds?: ContractAmendmentKind[];
  /** Days-back window; defaults to 365. */
  sinceDays?: number;
  /** Show the kind filter (Audit page = true; Renewals = false). */
  showKindFilter?: boolean;
  emptyLabel?: string;
}

const ALL_KINDS: ContractAmendmentKind[] = [
  "renewal",
  "salary_revision",
  "position_change",
  "location_change",
  "schedule_change",
  "allowance_change",
  "end_date_change",
  "other",
];

export function ContractsAmendmentsPage({
  eyebrow,
  title,
  description,
  kinds,
  sinceDays = 365,
  showKindFilter = false,
  emptyLabel = "No amendments recorded in this window.",
}: Props) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<ContractAmendmentKind | "all">("all");

  const effectiveKinds =
    kinds ??
    (kindFilter === "all" ? undefined : ([kindFilter] as ContractAmendmentKind[]));

  const { amendments, isLoading } = useContractAmendments({
    kind: effectiveKinds,
    sinceDays,
    limit: 500,
  });

  const rows = useMemo(() => {
    if (!search.trim()) return amendments;
    const s = search.toLowerCase();
    return amendments.filter(
      (a) =>
        (a.employee_name?.toLowerCase().includes(s) ?? false) ||
        (a.contract_reference?.toLowerCase().includes(s) ?? false) ||
        (a.summary?.toLowerCase().includes(s) ?? false),
    );
  }, [amendments, search]);

  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <PageBody fullWidth className="gap-4 sm:gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employee, reference, summary…"
              className="pl-8"
            />
          </div>
          {showKindFilter && (
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as any)}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Any kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any kind</SelectItem>
                  {ALL_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {AMENDMENT_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {isLoading ? "Loading…" : `${rows.length} amendment${rows.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center space-y-2">
              <Inbox className="h-8 w-8 text-muted-foreground mx-auto" />
              <div className="text-sm font-medium">{emptyLabel}</div>
              <p className="text-xs text-muted-foreground">
                Amendments recorded through the renew / amend workflows appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {rows.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 p-4 hover:bg-muted/40">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium truncate">
                          {a.employee_name ?? "—"}
                        </span>
                        {a.employee_number && (
                          <span className="text-xs text-muted-foreground">
                            #{a.employee_number}
                          </span>
                        )}
                        {a.contract_reference && (
                          <span className="text-xs text-muted-foreground truncate">
                            · {a.contract_reference}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          · {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant={amendmentKindTone(a.kind)}>
                          {AMENDMENT_KIND_LABELS[a.kind] ?? a.kind}
                        </Badge>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          Effective {format(new Date(a.effective_on), "MMM d, yyyy")}
                        </span>
                      </div>
                      {a.summary && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {a.summary}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        navigate(`/hr/employees/${a.employee_id}?section=contracts`)
                      }
                      title="Open employee"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}
