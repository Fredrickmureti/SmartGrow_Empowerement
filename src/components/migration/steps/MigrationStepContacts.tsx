import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { CheckCircle2, Upload, Info } from "lucide-react";
import { ImportWizard } from "@/components/common/ImportWizard";
import { CONTACT_IMPORT_FIELDS, createContactImportHandler, createContactBatchImportHandler } from "@/lib/contactImportConfig";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

export function MigrationStepContacts({ onComplete, onSkip }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [showImport, setShowImport] = useState(false);

  const { data: contacts = [], refetch } = useQuery({
    queryKey: ["contacts-migration-check", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      const { data } = await supabase
        .from("contacts")
        .select("id, type")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true);
      return data || [];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const handleImportRow = createContactImportHandler(
    currentOrg?.id || "",
    currentBusiness?.id || "",
    async (data) => {
      const { error } = await supabase.from("contacts").insert({
        organization_id: currentOrg!.id,
        business_id: currentBusiness!.id,
        ...data,
      } as any);
      if (error) throw error;
    },
    { dedup: true }
  );

  const handleBatchImport = createContactBatchImportHandler(
    currentOrg?.id || "",
    currentBusiness?.id || "",
    async (data) => {
      const { error } = await supabase.from("contacts").insert({
        organization_id: currentOrg!.id,
        business_id: currentBusiness!.id,
        ...data,
      } as any);
      if (error) throw error;
    }
  );

  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both").length;
  const suppliers = contacts.filter((c) => c.type === "supplier" || c.type === "both").length;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Contacts (Customers & Suppliers)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Import your customers and suppliers. These are needed before importing open AR/AP balances.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="text-center p-3 rounded-md bg-muted">
              <div className="text-lg font-bold">{customers}</div>
              <div className="text-xs text-muted-foreground">Customers</div>
            </div>
            <div className="text-center p-3 rounded-md bg-muted">
              <div className="text-lg font-bold">{suppliers}</div>
              <div className="text-xs text-muted-foreground">Suppliers</div>
            </div>
          </div>
          {contacts.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              {contacts.length} contacts found
            </div>
          )}
          {contacts.length === 0 && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                No contacts found. Import your customers and suppliers, or skip this step if you'll add them later.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowImport(true)} className="flex-1">
              <Upload className="mr-2 h-4 w-4" />
              Import Contacts
            </Button>
            <Button onClick={onComplete} disabled={contacts.length === 0} className="flex-1">
              Confirm Contacts
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={onSkip} className="w-full">
            Skip — add contacts later
          </Button>
        </CardContent>
      </Card>
      <ImportWizard
        open={showImport}
        onOpenChange={setShowImport}
        entityName="Contacts"
        fieldDefinitions={CONTACT_IMPORT_FIELDS}
        onImport={handleImportRow}
        onBatchImport={handleBatchImport}
        onComplete={() => { refetch(); setShowImport(false); }}
      />
    </>
  );
}
