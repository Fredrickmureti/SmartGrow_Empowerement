// @ts-nocheck - Tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Loader2, Scale, ChevronDown, CheckCircle2, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";

interface HistorySession {
  id: string;
  bank_account_id: string;
  statement_date: string;
  opening_balance: number;
  closing_balance: number;
  reconciled_balance: number;
  status: string;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  service_charge_amount: number | null;
  interest_earned_amount: number | null;
  bank_account: { name: string; bank_name: string | null } | null;
}

interface ClearedItem {
  id: string;
  transaction_id: string;
  status: string;
  cleared_at: string | null;
  transaction: {
    description: string;
    amount: number;
    transaction_type: string;
    transaction_date: string;
    reference: string | null;
    reconciled_type: string | null;
    reconciled_entity_id: string | null;
  } | null;
}

export function ReconciliationHistoryTab() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [clearedItems, setClearedItems] = useState<Record<string, ClearedItem[]>>({});
  const [loadingItems, setLoadingItems] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSource, setPreviewSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });

  useEffect(() => {
    fetchSessions();
  }, [currentOrg?.id, currentBusiness?.id]);

  const fetchSessions = async () => {
    if (!currentOrg?.id) return;
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("bank_reconciliation_sessions")
        .select(`*, bank_account:bank_accounts(name, bank_name)`)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      setSessions((data as unknown as HistorySession[]) || []);
    } catch (error) {
      console.error("Error fetching reconciliation history:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchClearedItems = async (sessionId: string) => {
    if (clearedItems[sessionId]) return;
    try {
      setLoadingItems(sessionId);
      const { data, error } = await supabase
        .from("bank_reconciliation_items")
        .select(`*, transaction:bank_transactions(description, amount, transaction_type, transaction_date, reference, reconciled_type, reconciled_entity_id)`)
        .eq("session_id", sessionId)
        .order("cleared_at", { ascending: false });

      if (error) throw error;
      setClearedItems(prev => ({ ...prev, [sessionId]: (data as unknown as ClearedItem[]) || [] }));
    } catch (error) {
      console.error("Error fetching cleared items:", error);
    } finally {
      setLoadingItems(null);
    }
  };

  const toggleExpand = (sessionId: string) => {
    if (expandedSession === sessionId) {
      setExpandedSession(null);
    } else {
      setExpandedSession(sessionId);
      fetchClearedItems(sessionId);
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

  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Scale className="h-12 w-12 mx-auto text-muted-foreground mb-4 opacity-50" />
          <p className="font-medium text-muted-foreground">No reconciliation history</p>
          <p className="text-sm text-muted-foreground mt-1">
            Complete a reconciliation session to see it here
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Scale className="h-5 w-5" />
          Reconciliation History
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sessions.map((session) => (
          <Collapsible key={session.id} open={expandedSession === session.id}>
            <CollapsibleTrigger
              className="w-full flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              onClick={() => toggleExpand(session.id)}
            >
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                <div className="text-left">
                  <p className="text-sm font-medium">{session.bank_account?.name || "Unknown Account"}</p>
                  <p className="text-xs text-muted-foreground">
                    Statement: {format(new Date(session.statement_date), "MMM d, yyyy")}
                    {session.completed_at && ` • Completed ${format(new Date(session.completed_at), "MMM d, yyyy h:mm a")}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-sm font-medium tabular-nums">{formatCurrency(session.closing_balance)}</p>
                  <p className="text-xs text-muted-foreground">Closing Balance</p>
                </div>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${expandedSession === session.id ? 'rotate-180' : ''}`} />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 ml-7 p-3 rounded-lg bg-muted/30 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Opening</p>
                    <p className="font-medium tabular-nums">{formatCurrency(session.opening_balance)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Closing</p>
                    <p className="font-medium tabular-nums">{formatCurrency(session.closing_balance)}</p>
                  </div>
                  {(session.service_charge_amount || 0) > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground">Service Charge</p>
                      <p className="font-medium tabular-nums text-destructive">-{formatCurrency(session.service_charge_amount!)}</p>
                    </div>
                  )}
                  {(session.interest_earned_amount || 0) > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground">Interest Earned</p>
                      <p className="font-medium tabular-nums text-green-600">+{formatCurrency(session.interest_earned_amount!)}</p>
                    </div>
                  )}
                </div>

                {loadingItems === session.id ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : clearedItems[session.id]?.length ? (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      {clearedItems[session.id].length} cleared transaction{clearedItems[session.id].length !== 1 ? 's' : ''}
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Date</TableHead>
                          <TableHead className="text-xs">Description</TableHead>
                          <TableHead className="text-xs">Reference</TableHead>
                          <TableHead className="text-xs text-right">Amount</TableHead>
                          <TableHead className="text-xs w-10" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {clearedItems[session.id].slice(0, 20).map((item) => {
                          const reconType = item.transaction?.reconciled_type;
                          const reconId = item.transaction?.reconciled_entity_id;
                          const canPreview = !!(reconType && reconId);
                          return (
                            <TableRow key={item.id}>
                              <TableCell className="text-xs">
                                {item.transaction?.transaction_date ? format(new Date(item.transaction.transaction_date), "MMM d") : "—"}
                              </TableCell>
                              <TableCell className="text-xs truncate max-w-[200px]">
                                {item.transaction?.description || "—"}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {item.transaction?.reference || "—"}
                              </TableCell>
                              <TableCell className={`text-xs text-right tabular-nums font-medium ${item.transaction?.transaction_type === "credit" ? "text-green-600" : "text-destructive"}`}>
                                {item.transaction?.transaction_type === "credit" ? "+" : "-"}
                                {formatCurrency(Math.abs(item.transaction?.amount || 0))}
                              </TableCell>
                              <TableCell className="text-right">
                                {canPreview && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    title="View matched source"
                                    onClick={() => {
                                      setPreviewSource({ type: reconType!, id: reconId! });
                                      setPreviewOpen(true);
                                    }}
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    {clearedItems[session.id].length > 20 && (
                      <p className="text-xs text-muted-foreground text-center mt-2">
                        And {clearedItems[session.id].length - 20} more...
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-2">No cleared items recorded for this session</p>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </CardContent>
      <TransactionPreviewDrawer
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        sourceType={previewSource.type}
        sourceId={previewSource.id}
      />
    </Card>
  );
}
