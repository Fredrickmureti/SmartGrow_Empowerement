/**
 * Mapping change log — read-only view of `mf_account_mapping_audit`.
 *
 * Rebinding a money-flow to a different ledger account never rewrites posted
 * history (postings dereference the account at post time), so the change log
 * is the record that explains why yesterday's and today's postings differ.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useAccounts } from "@/hooks/useAccounts";
import { useMfMappingAudit } from "@/hooks/useMfMappingAudit";
import { MF_MAPPING_SPECS } from "@/hooks/useMfAccountMappings";

const LABELS = new Map(MF_MAPPING_SPECS.map((s) => [s.key as string, s.label]));

export function MappingChangeLogCard() {
  const { accounts } = useAccounts();
  const { data: rows = [], isLoading, error } = useMfMappingAudit();

  const accountLabel = (id: string | null) => {
    if (!id) return "—";
    const a = accounts.find((acc: any) => acc.id === id) as any;
    return a ? `${a.code} ${a.name}` : "Unknown account";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mapping change log</CardTitle>
        <CardDescription>
          Every change to a lending money-flow's ledger account. Entries already
          posted keep the account they were posted to — this log explains the
          difference.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mapping changes recorded yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.id} className="border-b pb-3 text-sm last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {LABELS.get(row.mapping_key) ?? row.mapping_key}
                  </span>
                  <Badge variant="outline">{row.action}</Badge>
                  {row.branch_id ? <Badge variant="secondary">Branch override</Badge> : null}
                </div>
                <p className="text-muted-foreground">
                  {accountLabel(row.old_account_id)} → {accountLabel(row.new_account_id)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(row.created_at).toLocaleString()}
                  {row.changed_by_name ? ` · ${row.changed_by_name}` : ""}
                  {row.notes ? ` · ${row.notes}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default MappingChangeLogCard;
