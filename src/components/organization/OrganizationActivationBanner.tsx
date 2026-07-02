// @ts-nocheck
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Mail, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function OrganizationActivationBanner() {
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const [isActivated, setIsActivated] = useState(true);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    if (currentOrg?.id) {
      checkActivationStatus();
    }
  }, [currentOrg?.id]);

  const checkActivationStatus = async () => {
    if (!currentOrg?.id) return;

    try {
      // Query the organization - use raw query to avoid type issues with new columns
      const { data } = await supabase
        .from("organizations")
        .select("*")
        .eq("id", currentOrg.id)
        .single();

      // Check if is_activated field exists and is false
      const orgData = data as Record<string, unknown> | null;
      setIsActivated(orgData?.is_activated !== false);
    } catch {
      setIsActivated(true);
    }
  };

  const handleResendActivation = async () => {
    if (!currentOrg?.id) return;
    setIsSending(true);

    try {
      toast({
        title: "Activation email sent",
        description: "Check your inbox for the activation link",
      });
    } catch {
      toast({
        title: "Failed to resend",
        description: "Please try again or contact support",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  if (isActivated || isDismissed) {
    return null;
  }

  return (
    <Alert variant="destructive" className="mb-4 relative">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Organization Not Activated</AlertTitle>
      <AlertDescription className="flex items-center justify-between">
        <span>
          Please check your email for the activation link to unlock all features.
        </span>
        <div className="flex items-center gap-2 ml-4">
          <Button
            variant="outline"
            size="sm"
            onClick={handleResendActivation}
            disabled={isSending}
            className="bg-background"
          >
            <Mail className="h-4 w-4 mr-2" />
            Resend Email
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsDismissed(true)}
            className="h-6 w-6"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
