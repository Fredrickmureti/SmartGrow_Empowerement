/**
 * DocumentsListPage — reusable operational queue for the HR Document
 * Compliance sub-app.
 *
 * A single component drives Expiring / Expired / Unverified / All — the
 * difference is a filter descriptor. KPI-less header, search, per-row
 * drill-into-employee-profile.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import {
  Loader2,
  Inbox,
  ExternalLink,
  Search,
  ArrowUpDown,
  FileWarning,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, PageBody } from "@/design-system";
import {
  useEmployeeDocuments,
  documentBucketLabel,
  documentBucketTone,
  type EmployeeDocument,
} from "@/hooks/hr/useEmployeeDocuments";

export interface DocumentsListPageProps {
  eyebrow: string;
  title: string;
  description: string;
  expiringWithinDays?: number;
  onlyExpired?: boolean;
  onlyUnverified?: boolean;
  emptyLabel?: string;
}

export function DocumentsListPage(props: DocumentsListPageProps) {
  const {
    eyebrow,
    title,
    description,
    expiringWithinDays,
    onlyExpired,
    onlyUnverified,
    emptyLabel = "No documents match this queue.",
  } = props;

  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sortAsc, setSortAsc] = useState(true);

  const { documents, isLoading } = useEmployeeDocuments({
    expiringWithinDays,
    onlyExpired,
    onlyUnverified,
    search,
    limit: 1000,
  });

  const rows = useMemo(() => {
    const arr = [...documents];
    arr.sort((a, b) => {
      const av = a.days_to_expiry ?? Number.POSITIVE_INFINITY;
      const bv = b.days_to_expiry ?? Number.POSITIVE_INFINITY;
      return sortAsc ? av - bv : bv - av;
    });
    return arr;
  }, [documents, sortAsc]);

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
              placeholder="Search employee, document name, type…"
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {isLoading ? "Loading…" : `${rows.length} document${rows.length === 1 ? "" : "s"}`}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSortAsc((v) => !v)}>
              <ArrowUpDown className="mr-1 h-3.5 w-3.5" />
              {sortAsc ? "Soonest first" : "Latest first"}
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
                Documents appear here automatically once they match this queue.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {rows.map((d: EmployeeDocument) => (
                  <li key={d.id} className="flex items-start gap-3 p-4 hover:bg-muted/40">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium truncate">
                          {d.employee_name ?? "—"}
                        </span>
                        {d.employee_number && (
                          <span className="text-xs text-muted-foreground">
                            #{d.employee_number}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground truncate">
                          · {d.name ?? d.document_type ?? d.file_name ?? "Document"}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant={documentBucketTone(d.compliance_bucket)}>
                          <FileWarning className="mr-1 h-3 w-3" />
                          {documentBucketLabel(d.compliance_bucket)}
                        </Badge>
                        {d.document_type && (
                          <Badge variant="outline">{d.document_type}</Badge>
                        )}
                        {d.is_verified ? (
                          <Badge variant="outline" className="text-emerald-700 border-emerald-500/40">
                            <ShieldCheck className="mr-1 h-3 w-3" />
                            Verified
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-amber-700 border-amber-500/40">
                            <ShieldAlert className="mr-1 h-3 w-3" />
                            Unverified
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {d.expiry_date
                          ? `Expires ${format(new Date(d.expiry_date), "MMM d, yyyy")}`
                          : "No expiry date on file"}
                        {d.days_to_expiry !== null
                          ? d.days_to_expiry >= 0
                            ? ` · ${d.days_to_expiry} day${d.days_to_expiry === 1 ? "" : "s"} left`
                            : ` · expired ${Math.abs(d.days_to_expiry)}d ago`
                          : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          navigate(`/hr/employees/${d.employee_id}?section=documents`)
                        }
                        title="Open employee documents"
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
    </>
  );
}
