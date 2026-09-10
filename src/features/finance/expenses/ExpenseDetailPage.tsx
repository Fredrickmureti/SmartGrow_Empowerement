/**
 * Expense detail — read-only summary plus the lifecycle trail.
 *
 * Every fact on this page is server-owned: status, numbering, the approval
 * stamps and the ledger entry. The page only reads.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import { ArrowLeft, Loader2, Receipt } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";

type Row = Record<string, unknown> & {
  id: string;
  description: string;
  amount: number;
  currency: string;
  status: string;
  expense_date: string;
  category?: { name: string } | null;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending: "Pending",
  submitted: "Awaiting approval",
  approved: "Approved",
  paid: "Paid",
  rejected: "Rejected",
  voided: "Voided",
};

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "KES",
    minimumFractionDigits: 2,
  }).format(Number(amount || 0));

const when = (value: unknown) =>
  value ? format(new Date(String(value)), "dd MMM yyyy, HH:mm") : null;

export default function ExpenseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [row, setRow] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!id) return;
      setLoading(true);
      const { data, error: err } = await supabase
        .from("expenses")
        .select("*, category:expense_categories(name)" as string)
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(normalizeError(err).message);
      else setRow((data as unknown as Row) ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading expense…
      </div>
    );
  }

  if (error || !row) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={() => navigate("/finance/expenses")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to expenses
        </Button>
        <p className="text-sm text-muted-foreground">
          {error ?? "This expense could not be found."}
        </p>
      </div>
    );
  }

  const journalEntryId = row["journal_entry_id"] as string | null;

  const timeline = [
    { label: "Recorded", at: when(row["created_at"]) },
    { label: "Submitted", at: when(row["submitted_at"]) },
    { label: "Approved", at: when(row["approved_at"]) },
    { label: "Voided", at: when(row["voided_at"]) },
  ].filter((step) => step.at);

  const facts: Array<[string, string]> = [
    ["Date", format(new Date(row.expense_date), "dd MMM yyyy")],
    ["Category", row.category?.name ?? "Uncategorised"],
    ["Amount", money(row.amount, row.currency)],
    ["Payment method", String(row["payment_method"] ?? "—")],
    ["Reference", String(row["reference"] ?? "—")],
    ["Paid by", String(row["paid_by"] ?? "—")],
  ];

  return (
    <div className="space-y-6 p-6">
      <Button variant="ghost" onClick={() => navigate("/finance/expenses")}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to expenses
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {String(row["expense_number"] ?? "Expense")}
          </h1>
          <p className="text-sm text-muted-foreground">{row.description}</p>
        </div>
        <Badge variant={row.status === "voided" || row.status === "rejected" ? "destructive" : "default"}>
          {STATUS_LABEL[row.status] ?? row.status}
        </Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {facts.map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-sm font-medium">{value}</p>
              </div>
            ))}
            {row["void_reason"] ? (
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">Void reason</p>
                <p className="text-sm font-medium">{String(row["void_reason"])}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>What the system recorded, and when.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {timeline.map((step) => (
              <div key={step.label} className="flex items-baseline justify-between gap-4">
                <span className="text-sm font-medium">{step.label}</span>
                <span className="text-sm text-muted-foreground">{step.at}</span>
              </div>
            ))}
            {journalEntryId ? (
              <Button
                variant="outline"
                className="mt-2"
                onClick={() => navigate(`/finance/journal-entries/${journalEntryId}`)}
              >
                <Receipt className="mr-2 h-4 w-4" />
                View ledger entry
              </Button>
            ) : (
              <p className="pt-2 text-sm text-muted-foreground">
                No ledger entry yet — it is created when the expense is approved.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
