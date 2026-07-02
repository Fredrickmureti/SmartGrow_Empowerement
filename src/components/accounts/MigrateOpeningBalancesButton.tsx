import { normalizeError } from "@/services/resilience";
/**
 * Button component that migrates account opening_balance values
 * into a proper Opening Balance journal entry, then zeros them out.
 * This eliminates the dual-source problem (OB field + JE double-counting).
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface Props {
  imbalance?: number;
}

export function MigrateOpeningBalancesButton({ imbalance }: Props) {
  const [loading, setLoading] = useState(false);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleMigrate = async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("migrate_opening_balances_to_je", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness?.id || null,
        _entry_date: "2024-01-01",
      });

      if (error) throw error;

      toast({
        title: "Opening balances migrated",
        description: "A journal entry has been created and account opening balances have been zeroed out. Your reports will now be accurate.",
      });

      // Invalidate all relevant caches
      queryClient.invalidateQueries({ queryKey: ["financial-report"] });
      queryClient.invalidateQueries({ queryKey: ["opening-balance-check"] });
      queryClient.invalidateQueries({ queryKey: ["general-ledger"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
    } catch (err: any) {
      toast({
        title: "Migration failed",
        description: normalizeError(err).message || "Could not migrate opening balances",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <ArrowRightLeft className="h-4 w-4" />
          Convert to Journal Entry
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Migrate Opening Balances</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <p>
              This will create a <strong>posted Opening Balance journal entry</strong> from
              all account opening balance values, then <strong>zero out</strong> the
              opening_balance field on each account.
            </p>
            {imbalance && imbalance > 0.01 && (
              <p className="text-destructive font-medium">
                ⚠ Your opening balances are off by {imbalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}. 
                The difference will be posted to an equity account as an auto-balancing adjustment.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              This is the recommended approach — all balances should flow through journal entries
              for accurate double-entry reporting.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleMigrate} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Migrate Now
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
