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
  Download,
  Mail,
  MoreHorizontal,
  Eye,
  FileSignature,
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
import { toast } from "sonner";
import { dispatchHrLetter } from "@/features/hr/letters/dispatchHrLetter";
import { DocumentHistorySheet } from "@/components/documents/DocumentHistorySheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { printDocument } from "@/services/printing/PrintService";

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
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<Contract | null>(null);
  const [emailTarget, setEmailTarget] = useState<Contract | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  function contractLabel(c: Contract) {
    return `Contract ${c.contract_reference ?? c.employee_name ?? ""}`.trim();
  }

  /**
   * Download the contract as a PDF. Same front door as print: the pair is
   * frozen into a document record and rendered by the one renderer, so the
   * downloaded file is byte-identical to what a printer would receive.
   */
  async function downloadContractPdf(c: Contract) {
    setDownloadingId(c.id);
    try {
      const result = await printDocument({
        documentType: "contract_letter",
        documentId: c.id,
        medium: "pdf",
        intent: "a4_document",
        disposition: "download",
        filename: `contract-${(c.contract_reference ?? c.employee_name ?? c.id)
          .toString()
          .replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        organizationId: c.organization_id,
        businessId: c.business_id,
        branchId: c.branch_id,
      });
      if (!result.success) throw new Error(result.error ?? "Render failed");
      toast.success("Contract PDF downloaded");
    } catch (e) {
      toast.error("Could not export contract PDF", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setDownloadingId(null);
    }
  }

  /**
   * Freeze the contract into a document record and route it. The signed
   * terms are captured at issue time so a reprint can never drift from what
   * the employee actually agreed to.
   */
  async function issueContractLetter(contractId: string, label: string) {
    setIssuingId(contractId);
    try {
      await dispatchHrLetter({ letterType: "contract_letter", sourceId: contractId });
      toast.success(`${label} queued`, { description: "Track it under Documents." });
    } catch (e) {
      toast.error("Could not issue contract letter", {
        description: e instanceof Error ? e.message : "Unexpected error.",
      });
    } finally {
      setIssuingId(null);
    }
  }

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
                        onClick={() => setPreviewTarget(c)}
                        title="Preview and print the contract"
                      >
                        <Printer className="mr-1 h-3.5 w-3.5" />
                        Print
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" title="More actions">
                            {issuingId === c.id || downloadingId === c.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <MoreHorizontal className="h-4 w-4" />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuLabel>Document</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => setPreviewTarget(c)}>
                            <Eye className="mr-2 h-4 w-4" />
                            Preview
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={downloadingId === c.id}
                            onClick={() => downloadContractPdf(c)}
                          >
                            <Download className="mr-2 h-4 w-4" />
                            Export as PDF
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setEmailTarget(c)}>
                            <Mail className="mr-2 h-4 w-4" />
                            Email to employee
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={issuingId === c.id}
                            onClick={() => issueContractLetter(c.id, contractLabel(c))}
                          >
                            <FileSignature className="mr-2 h-4 w-4" />
                            Issue &amp; route to printer
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() =>
                              navigate(`/hr/employees/${c.employee_id}?section=contracts`)
                            }
                          >
                            <ExternalLink className="mr-2 h-4 w-4" />
                            Open employee
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <DocumentHistorySheet
                        documentType="contract_letter"
                        documentId={c.id}
                        title={contractLabel(c)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </PageBody>

      <PrintPreviewDialog
        open={!!previewTarget}
        onOpenChange={(o) => !o && setPreviewTarget(null)}
        title={previewTarget ? contractLabel(previewTarget) : "Contract"}
        filename={`contract-${previewTarget?.contract_reference ?? previewTarget?.id ?? "document"}`}
        documentType="contract_letter"
        documentId={previewTarget?.id}
      />

      <SendDocumentDialog
        open={!!emailTarget}
        onOpenChange={(o) => !o && setEmailTarget(null)}
        document={
          emailTarget
            ? {
                documentType: "contract_letter",
                documentId: emailTarget.id,
                documentNumber:
                  emailTarget.contract_reference ?? emailTarget.name ?? "contract",
                recipientEmail: emailTarget.employee_email ?? undefined,
                recipientName: emailTarget.employee_name ?? undefined,
              }
            : null
        }
      />

      <RenewContractDialog
        contract={renewTarget}
        open={!!renewTarget}
        onOpenChange={(o) => !o && setRenewTarget(null)}
      />
    </>
  );
}
