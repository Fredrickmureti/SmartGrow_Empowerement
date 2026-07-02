import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";

interface MissingRole {
  setting_key: string;
  suggested_account_type: string;
  is_required: boolean;
}

/**
 * Surfaces missing required system-account mappings (AR, AP, Cash, Sales, etc.)
 * by calling the `validate_required_system_roles` RPC. Renders nothing when
 * all required roles are mapped — never noisy.
 */
export function MissingSystemAccountsBanner() {
  const { currentBusiness } = useBusinesses();

  const { data: missing = [] } = useQuery({
    queryKey: ["validate-system-roles", currentBusiness?.id],
    queryFn: async (): Promise<MissingRole[]> => {
      if (!currentBusiness?.id) return [];
      const { data, error } = await supabase.rpc(
        "validate_required_system_roles",
        { _business_id: currentBusiness.id }
      );
      if (error) {
        console.warn("validate_required_system_roles failed:", error.message);
        return [];
      }
      return (data ?? []).filter((r: MissingRole) => r.is_required);
    },
    enabled: !!currentBusiness?.id,
    staleTime: 60_000,
  });

  if (missing.length === 0) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {missing.length} required system account{missing.length === 1 ? "" : "s"} not mapped
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p className="text-sm">
          Some core accounting workflows (invoicing, payments, posting) will fail
          until every required role is mapped to an account.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {missing.slice(0, 8).map((m) => (
            <Badge key={m.setting_key} variant="outline" className="font-mono text-xs">
              {m.setting_key}
            </Badge>
          ))}
          {missing.length > 8 && (
            <Badge variant="outline" className="text-xs">
              +{missing.length - 8} more
            </Badge>
          )}
        </div>
        <Button asChild size="sm" variant="secondary">
          <Link to="/finance/settings">
            Map default accounts
            <ArrowRight className="ml-2 h-3.5 w-3.5" />
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
