/**
 * EmployeeLinkRequired — single source of truth for the "you are not linked
 * to an employee record" empty state across the /me/* portal.
 *
 * Behaviour:
 *   - For regular portal users: shows a read-only message instructing them
 *     to contact HR. NO action button is rendered, because they cannot
 *     create their own employee record (the RPC will reject them).
 *   - For org owners/admins of a brand-new workspace (`canSelfLink === true`
 *     from useCurrentEmployee, which itself comes from the server-side
 *     resolve_my_employee RPC): shows an "Add me as an employee" button
 *     that calls link_self_as_employee.
 *
 * This component replaces 9+ bespoke empty states scattered across the
 * /me/* pages. Do NOT add a new ad-hoc "not linked" message anywhere —
 * import this instead.
 */
import { useState } from "react";
import { Loader2, UserPlus, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";

interface EmployeeLinkRequiredProps {
  /** Override the title (default: "No employee profile"). */
  title?: string;
  /**
   * Override the description shown to non-admin users. Defaults to a
   * generic "contact HR" message that fits every /me/* surface.
   */
  description?: string;
}

export function EmployeeLinkRequired({
  title = "No employee profile",
  description = "Your account isn't linked to an HR record yet, so this section is unavailable. Please contact your HR administrator to be added.",
}: EmployeeLinkRequiredProps) {
  const { canSelfLink, refreshCurrentEmployee } = useCurrentEmployee();
  const [isLinking, setIsLinking] = useState(false);

  const handleSelfLink = async () => {
    if (isLinking) return;
    setIsLinking(true);
    try {
      const { error } = await supabase.rpc("link_self_as_employee" as any);
      if (error) throw error;
      toast.success("Your employee profile has been created.");
      await refreshCurrentEmployee();
    } catch (err: any) {
      console.error("[EmployeeLinkRequired] link_self_as_employee failed:", err);
      toast.error(err?.message ?? "Could not create your employee profile.");
    } finally {
      setIsLinking(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <Card>
        <CardContent className="flex flex-col items-center text-center py-12 px-6">
          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
            <UserX className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground mt-2 max-w-md">
            {canSelfLink
              ? "Your workspace doesn't have an employee record for you yet. As the workspace owner, you can create one now to start using HR & payroll features."
              : description}
          </p>
          {canSelfLink ? (
            <Button className="mt-5" onClick={handleSelfLink} disabled={isLinking}>
              {isLinking ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating…
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4 mr-2" /> Add me as an employee
                </>
              )}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export default EmployeeLinkRequired;
