import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { CheckCircle2, Upload, Info } from "lucide-react";
import { ImportWizard } from "@/components/common/ImportWizard";
import { PRODUCT_MIGRATION_FIELDS, createProductMigrationHandler, createProductBatchMigrationHandler } from "@/lib/importConfigs/productImportConfig";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

export function MigrationStepProducts({ onComplete, onSkip }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [showImport, setShowImport] = useState(false);

  const { data: products = [], refetch } = useQuery({
    queryKey: ["products-migration-check", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data } = await supabase
        // SCOPE-EXEMPT: migration progress check across workspace
        .from("products")
        .select("id, product_type")
        .eq("organization_id", currentOrg.id)
        .eq("status", "active");
      return data || [];
    },
    enabled: !!currentOrg?.id,
  });

  const handleImportRow = createProductMigrationHandler(currentOrg?.id || "");
  const handleBatchImport = createProductBatchMigrationHandler({
    orgId: currentOrg?.id || "",
    businessId: currentBusiness?.id || currentOrg?.id || "",
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Products & Items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Import products and services. Needed before importing inventory opening balances.
          </p>
          {products.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              {products.length} active products found
            </div>
          )}
          {products.length === 0 && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                No products found. Import your products/services, or skip if you'll add them later.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowImport(true)} className="flex-1">
              <Upload className="mr-2 h-4 w-4" />
              Import Products
            </Button>
            <Button onClick={onComplete} disabled={products.length === 0} className="flex-1">
              Confirm Products
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={onSkip} className="w-full">
            Skip — add products later
          </Button>
        </CardContent>
      </Card>
      <ImportWizard
        open={showImport}
        onOpenChange={setShowImport}
        entityName="Products"
        fieldDefinitions={PRODUCT_MIGRATION_FIELDS}
        onImport={handleImportRow}
        onBatchImport={handleBatchImport}
        onComplete={() => { refetch(); setShowImport(false); }}
      />
    </>
  );
}
