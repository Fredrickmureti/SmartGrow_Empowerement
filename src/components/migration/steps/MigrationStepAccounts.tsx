import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { CheckCircle2, Upload } from "lucide-react";
import { ImportWizard } from "@/components/common/ImportWizard";
import { ACCOUNT_MIGRATION_FIELDS, createAccountMigrationHandler, createAccountBatchMigrationHandler } from "@/lib/importConfigs/accountImportConfig";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

export function MigrationStepAccounts({ onComplete, onSkip }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [showImport, setShowImport] = useState(false);

  const { data: accounts = [], refetch } = useQuery({
    queryKey: ["accounts-migration-check", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      const { data } = await supabase
        .from("accounts")
        .select("id, code, name, account_type")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("code");
      return data || [];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const handleImportRow = createAccountMigrationHandler(currentOrg?.id || "", currentBusiness?.id || "");
  const handleBatchImport = createAccountBatchMigrationHandler(currentOrg?.id || "", currentBusiness?.id || "");

  const typeCounts = accounts.reduce(
    (acc, a) => {
      acc[a.account_type] = (acc[a.account_type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Chart of Accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Import your chart of accounts or verify the existing one. You need at least one account of each type (Asset, Liability, Equity, Revenue, Expense).
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {["asset", "liability", "equity", "income", "expense"].map((type) => (
              <div key={type} className="text-center p-2 rounded-md bg-muted">
                <div className="text-lg font-bold">{typeCounts[type] || 0}</div>
                <div className="text-xs text-muted-foreground capitalize">{type}</div>
              </div>
            ))}
          </div>

          {accounts.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              {accounts.length} active accounts found
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowImport(true)} className="flex-1">
              <Upload className="mr-2 h-4 w-4" />
              Import Accounts
            </Button>
            <Button
              onClick={onComplete}
              disabled={accounts.length === 0}
              className="flex-1"
            >
              Confirm Accounts
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={onSkip} className="w-full">
            Skip — use existing accounts
          </Button>
        </CardContent>
      </Card>

      <ImportWizard
        open={showImport}
        onOpenChange={setShowImport}
        entityName="Accounts"
        fieldDefinitions={ACCOUNT_MIGRATION_FIELDS}
        onImport={handleImportRow}
        onBatchImport={handleBatchImport}
        onComplete={() => {
          refetch();
          setShowImport(false);
        }}
      />
    </>
  );
}
