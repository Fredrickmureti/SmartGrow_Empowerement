/**
 * Governance → Segregation of Duties report.
 *
 * Lists every (user × conflicting duty-pair) currently held in the active
 * organization. Read-only auditor view — Wave G1.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

type Violation = {
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  duty_a: string;
  duty_b: string;
  severity: "critical" | "high" | "medium" | "low";
  rationale: string;
};

const sevColor: Record<Violation["severity"], string> = {
  critical: "bg-destructive text-destructive-foreground",
  high:     "bg-orange-500 text-white",
  medium:   "bg-amber-500 text-white",
  low:      "bg-muted text-foreground",
};

export default function GovernanceSoD() {
  const { activeOrganizationId } = useSession() as any;

  const { data, isLoading, error } = useQuery({
    queryKey: ["governance-sod-violations", activeOrganizationId],
    enabled: !!activeOrganizationId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("governance_sod_violations" as any, {
        _org_id: activeOrganizationId,
      });
      if (error) throw error;
      return (data ?? []) as Violation[];
    },
  });

  const grouped = useMemo(() => {
    const m = new Map<string, Violation[]>();
    (data ?? []).forEach((v) => {
      const k = v.user_id;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(v);
    });
    return Array.from(m.entries());
  }, [data]);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-3xl font-semibold flex items-center gap-2">
          <ShieldAlert className="h-7 w-7" />
          Segregation of Duties
        </h1>
        <p className="text-muted-foreground mt-1">
          Users currently holding incompatible duty combinations. Combinations follow standard
          ERP control matrices (SAP GRC, Oracle Risk Cloud). Resolve by splitting duties across
          two people or by removing the conflicting permission.
        </p>
      </header>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-destructive text-sm">
            {(error as Error).message}
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && grouped.length === 0 && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <ShieldCheck className="h-10 w-10 text-emerald-500" />
            <p className="font-medium">No segregation-of-duties violations detected.</p>
            <p className="text-sm text-muted-foreground">
              Every user in this organization holds a permission combination that respects the
              maker-checker principle.
            </p>
          </CardContent>
        </Card>
      )}

      {grouped.map(([userId, rows]) => (
        <Card key={userId}>
          <CardHeader>
            <CardTitle className="text-base">
              {rows[0].user_name || rows[0].user_email || userId}
            </CardTitle>
            <CardDescription>{rows[0].user_email}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Conflicting duties</TableHead>
                  <TableHead>Why this matters</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((v, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Badge className={sevColor[v.severity]}>{v.severity}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {v.duty_a} <span className="text-muted-foreground">×</span> {v.duty_b}
                    </TableCell>
                    <TableCell className="text-sm">{v.rationale}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
