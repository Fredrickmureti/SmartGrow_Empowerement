/**
 * ContractsListPage — reusable operational queue for the Contracts sub-app.
 *
 * A single component drives Drafts / Pending approval / Active / Expiring
 * (30/60/90) / All / Expired — the difference is a filter descriptor.
 * KPI header, search, per-row drill-into-profile, and (for expiring/active
 * queues) a "Renew" action wired to the existing `renew_contract` RPC.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import {
  Loader2,
  Inbox,
  ExternalLink,
  RefreshCw,
  Search,
  ArrowUpDown,
  Printer,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, PageBody } from "@/design-system";
import {
  useContracts,
  contractStatusLabel,
  contractStatusTone,
  type Contract,
  type ContractStatus,
} from "@/hooks/hr/useContracts";
import { RenewContractDialog } from "./RenewContractDialog";
import { usePrintOrPreview } from "@/hooks/usePrintOrPreview";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";

export interface ContractsListPageProps {
  eyebrow: string;
  title: string;
  description: string;
  status?: ContractStatus | ContractStatus[];
  expiringWithinDays?: number;
  onlyExpired?: boolean;
  /** Show the renew action on each row. */
  allowRenew?: boolean;
  /** When set, render bucket badges (used by Expiring). */
  showBuckets?: boolean;
  emptyLabel?: string;
}

function bucketBadge(b: Contract["expiry_bucket"]) {
  if (!b) return null;
  if (b === "0-30") return <Badge variant="destructive">≤ 30 days</Badge>;
  if (b === "31-60")
    return (
      <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/20">
        31–60 days
      </Badge>
    );
  return <Badge variant="secondary">61–90 days</Badge>;
}

export function ContractsListPage(props: ContractsListPageProps) {
  const {
    eyebrow,
    title,
    description,
    status,
    expiringWithinDays,
    onlyExpired,
    allowRenew = false,
    showBuckets = false,
    emptyLabel = "No contracts match this queue.",
  } = props;

  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [renewTarget, setRenewTarget] = useState<Contract | null>(null);
  const [sortAsc, setSortAsc] = useState(false);
  const {
    printPreviewOpen,
    setPrintPreviewOpen,
    printPreviewTitle,
    printDocumentType,
    printDocumentId,
    printCommunication,
    generateDocument,
  } = usePrintOrPreview();

  const { contracts, isLoading } = useContracts({
    status,
    expiringWithinDays,
    onlyExpired,
    search,
    limit: 1000,
  });

  const rows = useMemo(() => {
    const arr = [...contracts];
    // For expiring queues, prefer sorting by days_to_expiry ascending.
    if (expiringWithinDays) {
      arr.sort((a, b) => {
        const av = a.days_to_expiry ?? Number.POSITIVE_INFINITY;
        const bv = b.days_to_expiry ?? Number.POSITIVE_INFINITY;
        return sortAsc ? bv - av : av - bv;
      });
    } else {
      arr.sort((a, b) => {
        const at = new Date(a.updated_at).getTime();
        const bt = new Date(b.updated_at).getTime();
        return sortAsc ? at - bt : bt - at;
      });
    }
    return arr;
  }, [contracts, expiringWithinDays, sortAsc]);

  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <PageBody fullWidth className="gap-4 sm:gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employee, reference, name…"
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {isLoading ? "Loading…" : `${rows.length} contract${rows.length === 1 ? "" : "s"}`}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSortAsc((v) => !v)}>
              <ArrowUpDown className="mr-1 h-3.5 w-3.5" />
              {expiringWithinDays
                ? sortAsc ? "Latest first" : "Soonest first"
                : sortAsc ? "Oldest first" : "Newest first"}
            </Button>
          </div>
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
                Contracts appear here automatically once they match this queue.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {rows.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 p-4 hover:bg-muted/40">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium truncate">
                          {c.employee_name ?? "—"}
                        </span>
                        {c.employee_number && (
                          <span className="text-xs text-muted-foreground">
                            #{c.employee_number}
                          </span>
                        )}
                        {c.contract_reference && (
                          <span className="text-xs text-muted-foreground truncate">
                            · {c.contract_reference}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant={contractStatusTone(c.status)}>
                          {contractStatusLabel(c.status)}
                        </Badge>
                        {showBuckets && bucketBadge(c.expiry_bucket)}
                        {c.amendments_count > 0 && (
                          <Badge variant="outline">
                            {c.amendments_count} amendment
                            {c.amendments_count === 1 ? "" : "s"}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {c.start_date ? `Starts ${format(new Date(c.start_date), "MMM d, yyyy")}` : "No start"}
                        {c.end_date ? ` · ends ${format(new Date(c.end_date), "MMM d, yyyy")}` : " · open-ended"}
                        {c.days_to_expiry !== null && c.status === "running"
                          ? c.days_to_expiry >= 0
                            ? ` · ${c.days_to_expiry} day${c.days_to_expiry === 1 ? "" : "s"} left`
                            : ` · expired ${Math.abs(c.days_to_expiry)}d ago`
                          : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {allowRenew && (c.status === "running" || c.status === "expired") && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRenewTarget(c)}
                        >
                          <RefreshCw className="mr-1 h-3.5 w-3.5" />
                          Renew
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          generateDocument(
                            "contract_letter",
                            c.id,
                            `Contract ${c.contract_reference ?? c.employee_name ?? ""}`.trim(),
                          )
                        }
                        title="Print contract letter"
                      >
                        <Printer className="mr-1 h-3.5 w-3.5" />
                        Print
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          navigate(`/hr/employees/${c.employee_id}?section=contracts`)
                        }
                        title="Open employee"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </PageBody>

      <RenewContractDialog
        contract={renewTarget}
        open={!!renewTarget}
        onOpenChange={(o) => !o && setRenewTarget(null)}
      />

      <PrintPreviewDialog
        open={printPreviewOpen}
        onOpenChange={setPrintPreviewOpen}
        title={printPreviewTitle}
        documentType={printDocumentType}
        documentId={printDocumentId}
        communication={printCommunication}
      />
    </>
  );
}
