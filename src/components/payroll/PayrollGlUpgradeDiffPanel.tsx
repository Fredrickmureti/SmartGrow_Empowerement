/**
 * PayrollGlUpgradeDiffPanel — Phase 3.
 *
 * Surfaces `payroll_gl_upgrade_diff` results on the Payroll Account Mapping
 * page so accountants can see, at a glance, what has changed relative to
 * the installed localization pack:
 *
 *   • new_key                — action: apply pack recommendation
 *   • deprecated_key         — action: review / open in Chart of Accounts
 *   • stale_pack_version     — action: re-verify (apply refresh)
 *   • changed_recommendation — action: switch to new recommendation
 *
 * The panel collapses to nothing when there is nothing to show, so it is
 * safe to render unconditionally at the top of the mapping page.
 */
import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  usePayrollGlUpgradeDiff,
  type PayrollUpgradeDiffRow,
  type PayrollUpgradeDiffStatus,
} from "@/hooks/payroll/usePayrollGlUpgradeDiff";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  PackageCheck,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";

const BUCKET_META: Record<
  PayrollUpgradeDiffStatus,
  { label: string; description: string; icon: any; tone: string }
> = {
  new_key: {
    label: "New posting keys",
    description:
      "Required by the active statutory rulebook but not yet bound to a Chart of Accounts entry.",
    icon: Sparkles,
    tone: "text-amber-600",
  },
  changed_recommendation: {
    label: "Recommendation changed",
    description:
      "Currently bound to a pack-supplied account, but the pack now recommends a different account.",
    icon: RefreshCw,
    tone: "text-blue-600",
  },
  stale_pack_version: {
    label: "Older pack version",
    description:
      "Mapping was written by an older pack version than the one currently installed — re-verify.",
    icon: ArrowUpRight,
    tone: "text-indigo-600",
  },
  deprecated_key: {
    label: "Deprecated keys",
    description:
      "Mapped, but the current statutory rulebook no longer emits this posting key.",
    icon: Trash2,
    tone: "text-muted-foreground",
  },
};

export function PayrollGlUpgradeDiffPanel() {
  const diff = usePayrollGlUpgradeDiff();
  const [open, setOpen] = useState(true);

  if (diff.isLoading || diff.total === 0) return null;

  const buckets = diff.buckets;
  const bucketOrder: PayrollUpgradeDiffStatus[] = [
    "new_key",
    "changed_recommendation",
    "stale_pack_version",
    "deprecated_key",
  ];

  return (
    <Card className="border-amber-200/60 bg-amber-50/30 dark:bg-amber-950/10">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <PackageCheck className="h-4 w-4 text-amber-600" />
              <CardTitle className="text-base">
                Pack upgrade diff
              </CardTitle>
              <Badge variant="secondary">{diff.total}</Badge>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <span className="ml-1 text-xs">{open ? "Hide" : "Show"}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
          <p className="text-xs text-muted-foreground">
            What changed in the localization pack rulebook vs. the mappings on
            file. Purely informational — nothing is changed until you act.
          </p>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            {bucketOrder.map((status) => {
              const rows = buckets[status];
              if (rows.length === 0) return null;
              return (
                <BucketBlock
                  key={status}
                  status={status}
                  rows={rows}
                  onApply={(row) => diff.applyRecommendation.mutate(row)}
                  applying={diff.applyRecommendation.isPending}
                />
              );
            })}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

interface BucketBlockProps {
  status: PayrollUpgradeDiffStatus;
  rows: PayrollUpgradeDiffRow[];
  onApply: (row: PayrollUpgradeDiffRow) => void;
  applying: boolean;
}

function BucketBlock({ status, rows, onApply, applying }: BucketBlockProps) {
  const meta = BUCKET_META[status];
  const Icon = meta.icon;
  const showApply =
    status === "new_key" ||
    status === "changed_recommendation" ||
    status === "stale_pack_version";

  return (
    <div className="rounded-md border bg-background">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <Icon className={`h-4 w-4 ${meta.tone}`} />
        <div className="flex-1">
          <div className="text-sm font-medium">{meta.label}</div>
          <div className="text-xs text-muted-foreground">{meta.description}</div>
        </div>
        <Badge variant="outline">{rows.length}</Badge>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[200px]">Posting key</TableHead>
              <TableHead>Bound today</TableHead>
              <TableHead>Pack recommendation</TableHead>
              <TableHead>Pack version</TableHead>
              {showApply && <TableHead className="text-right">Action</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${status}-${r.setting_key}`}>
                <TableCell>
                  <div className="font-medium text-sm">{r.label}</div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {r.setting_key}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {r.current_account_code ? (
                    <span>
                      <span className="font-mono">{r.current_account_code}</span>{" "}
                      — {r.current_account_name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">Not bound</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {r.recommended_account_code ? (
                    <span>
                      <span className="font-mono">{r.recommended_account_code}</span>{" "}
                      — {r.recommended_account_name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">
                      {status === "deprecated_key" ? "n/a" : "No suggestion"}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <div className="flex flex-col">
                    <span>
                      <span className="text-muted-foreground">on row: </span>
                      <span className="font-mono">{r.current_pack_version ?? "—"}</span>
                    </span>
                    <span>
                      <span className="text-muted-foreground">installed: </span>
                      <span className="font-mono">{r.installed_pack_version ?? "—"}</span>
                    </span>
                  </div>
                </TableCell>
                {showApply && (
                  <TableCell className="text-right">
                    {r.recommended_account_id ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={applying}
                        onClick={() => onApply(r)}
                      >
                        <Sparkles className="h-3.5 w-3.5 mr-1" />
                        Apply
                      </Button>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Manual
                      </span>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
