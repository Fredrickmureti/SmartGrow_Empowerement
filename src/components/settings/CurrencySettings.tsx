/**
 * CurrencySettings — Kenya-only institution.
 *
 * Wave 4 verdict (see `.lovable/plan.md`): this is a Kenyan microfinance
 * institution. Every client, loan, repayment and receipt is denominated in
 * Kenyan Shillings, so there is no legitimate business reason to let an
 * operator change the base currency, enable additional currencies, or
 * publish/override exchange rates.
 *
 * The multi-currency plumbing (`currencies`, `business_active_currencies`,
 * `exchange_rates`) is deliberately KEPT in the database because the retained
 * accounting engine joins those tables, but it is no longer user-configurable:
 * the base currency is pinned to KES by a database constraint and the
 * rate-book RPCs are no longer reachable from the app.
 */
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LockKeyhole } from "lucide-react";

export function CurrencySettings() {
  const { currentBusiness } = useBusinesses();
  const base = (currentBusiness?.base_currency ?? "KES").toUpperCase();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <LockKeyhole className="h-4 w-4 text-muted-foreground" />
              Currency
            </CardTitle>
            <CardDescription>
              This institution operates in Kenyan Shillings only.
            </CardDescription>
          </div>
          <Badge variant="secondary" className="text-base">
            {base}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>
          All loans, repayments, receipts and accounting entries are recorded in{" "}
          <span className="font-medium text-foreground">
            KES — Kenyan Shilling (KSh)
          </span>
          .
        </p>
        <p>
          The base currency is fixed and cannot be changed, so no exchange rates
          need to be maintained.
        </p>
      </CardContent>
    </Card>
  );
}

export default CurrencySettings;
