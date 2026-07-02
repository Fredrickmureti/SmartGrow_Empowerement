// @ts-nocheck - Tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, FileSpreadsheet, Calendar } from "lucide-react";
import { format } from "date-fns";

interface ImportBatch {
  id: string;
  file_name: string;
  file_hash: string;
  status: string;
  transaction_count: number | null;
  period_start: string | null;
  period_end: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  total_debits: number | null;
  total_credits: number | null;
  created_at: string;
  imported_by: string | null;
  bank_account: { name: string; bank_name: string | null } | null;
}

export function ImportHistoryTab() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchBatches();
  }, [currentOrg?.id, currentBusiness?.id]);

  const fetchBatches = async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;

    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("bank_statements")
        .select(`*, bank_account:bank_accounts(name, bank_name)`)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      setBatches((data as unknown as ImportBatch[]) || []);
    } catch (error) {
      console.error("Error fetching import history:", error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (batches.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <FileSpreadsheet className="h-12 w-12 mx-auto text-muted-foreground mb-4 opacity-50" />
          <p className="font-medium text-muted-foreground">No import history</p>
          <p className="text-sm text-muted-foreground mt-1">
            Import bank statements to see them here
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Import History
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Bank Account</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Transactions</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Imported</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.map((batch) => (
              <TableRow key={batch.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate max-w-[200px] font-medium text-sm">
                      {batch.file_name}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {batch.bank_account?.name || "—"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {batch.period_start && batch.period_end
                    ? `${format(new Date(batch.period_start), "MMM d")} – ${format(new Date(batch.period_end), "MMM d, yyyy")}`
                    : "—"}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {batch.transaction_count ?? 0}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={batch.status === "completed" ? "default" : "secondary"}
                    className={
                      batch.status === "completed"
                        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                        : batch.status === "processing"
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                        : ""
                    }
                  >
                    {batch.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {format(new Date(batch.created_at), "MMM d, yyyy h:mm a")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
