/**
 * UpcomingDeadlinesWidget — forward-looking 14-day deadline panel.
 * Renders bills due, invoices due, and payroll runs about to land,
 * sorted by date. Hidden when no items resolve.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarClock, FileText, Receipt, Users, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { useUpcomingDeadlines } from "@/hooks/useUpcomingDeadlines";
import { useCurrency } from "@/hooks/useCurrency";

interface Props {
  hasSales: boolean;
  hasPurchases: boolean;
  hasHR: boolean;
}

const ICONS = {
  invoice: FileText,
  bill: Receipt,
  payroll: Users,
} as const;

const TONES: Record<string, string> = {
  invoice: "bg-blue-100 text-blue-800",
  bill: "bg-orange-100 text-orange-800",
  payroll: "bg-purple-100 text-purple-800",
};

export function UpcomingDeadlinesWidget({ hasSales, hasPurchases, hasHR }: Props) {
  const navigate = useNavigate();
  const { data, isLoading } = useUpcomingDeadlines({ hasSales, hasPurchases, hasHR });
  const { formatCurrency } = useCurrency();

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4" />
            Upcoming (next 14 days)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!data || data.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarClock className="h-4 w-4" />
          Upcoming (next 14 days)
          <Badge variant="secondary">{data.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.map((item) => {
          const Icon = ICONS[item.kind];
          return (
            <button
              key={item.id}
              onClick={() => navigate(item.href)}
              className="w-full flex items-center justify-between gap-3 rounded-lg border bg-card p-2.5 hover:bg-muted/60 transition-colors text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className={`h-7 w-7 rounded-md flex items-center justify-center ${TONES[item.kind]}`}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{item.label}</p>
                  <p className="text-xs text-muted-foreground">
                    Due {format(new Date(item.dueDate), "MMM d")}
                  </p>
                </div>
              </div>
              {typeof item.amount === "number" && item.amount > 0 ? (
                <span className="text-sm font-semibold tabular-nums flex-shrink-0">
                  {formatCurrency(item.amount)}
                </span>
              ) : null}
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}