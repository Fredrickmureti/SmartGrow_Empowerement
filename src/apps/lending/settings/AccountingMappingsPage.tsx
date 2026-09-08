/**
 * Lending → Configuration → Accounting mappings (C2).
 *
 * The single place where microfinance money-flows are bound to ledger
 * accounts. Domain code resolves accounts through these mappings and never
 * names an account UUID.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import { MF_MAPPING_SPECS, useMfAccountMappings } from "@/hooks/useMfAccountMappings";
import { AllocationPolicyCard } from "./AllocationPolicyCard";
import { AdmissionFeeCard } from "./AdmissionFeeCard";
import { MappingChangeLogCard } from "./MappingChangeLogCard";

export function AccountingMappingsPage() {
  const { accounts, isLoading: accountsLoading } = useAccounts();
  const { resolved, isLoading, error, setMapping } = useMfAccountMappings();

  return (
    <div className="space-y-6 p-6">
      <AllocationPolicyCard />
      <AdmissionFeeCard />
      <Card>
        <CardHeader>
          <CardTitle>Accounting mappings</CardTitle>
          <CardDescription>
            Bind each lending money-flow to a ledger account. Disbursements,
            repayments, fees, penalties and write-offs post through these
            mappings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <p className="text-sm text-destructive">{error.message}</p>
          ) : isLoading || accountsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            MF_MAPPING_SPECS.map((spec) => (
              <div
                key={spec.key}
                className="grid items-center gap-3 border-b pb-4 last:border-b-0 last:pb-0 md:grid-cols-2"
              >
                <div>
                  <p className="text-sm font-medium">{spec.label}</p>
                  <p className="text-xs text-muted-foreground">{spec.description}</p>
                </div>
                <AccountCombobox
                  accounts={accounts}
                  value={resolved.get(spec.key)?.account_id ?? ""}
                  onValueChange={(accountId) =>
                    setMapping.mutate({ key: spec.key, accountId })
                  }
                  placeholder="Select account"
                  allowedTypes={[spec.accountType]}
                  disabled={setMapping.isPending}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <MappingChangeLogCard />
    </div>
  );
}

export default AccountingMappingsPage;
