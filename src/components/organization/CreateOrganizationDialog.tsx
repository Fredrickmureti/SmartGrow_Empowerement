import { useState, useEffect } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { usePendingBusinessSetup } from "@/hooks/usePendingBusinessSetup";
import { useSubscriptionLimits } from "@/hooks/useSubscriptionLimits";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Loader2, AlertCircle, ArrowUpCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { normalizeError } from "@/services/resilience";

interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function CreateOrganizationDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateOrganizationDialogProps) {
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<"single" | "multi">("single");
  const [isLoading, setIsLoading] = useState(false);
  const [limitCheck, setLimitCheck] = useState<{
    canCreate: boolean;
    currentCount: number;
    maxAllowed: number | null;
    isUnlimited: boolean;
  } | null>(null);
  const [isCheckingLimit, setIsCheckingLimit] = useState(false);

  const { user } = useAuth();
  const { createOrganization } = useOrganization();
  const { getPendingSetup, clearPendingSetup } = usePendingBusinessSetup(user?.user_metadata);
  const { checkOrganizationLimit } = useSubscriptionLimits();
  const { toast } = useToast();
  const navigate = useNavigate();

  // Check limits when dialog opens
  useEffect(() => {
    if (open) {
      setIsCheckingLimit(true);
      checkOrganizationLimit().then((result) => {
        setLimitCheck(result);
        setIsCheckingLimit(false);
      });
    }
  }, [open, checkOrganizationLimit]);

  // Pre-populate from pending business setup if available
  useEffect(() => {
    if (open && !name) {
      const pendingSetup = getPendingSetup();
      if (pendingSetup?.businessName) {
        setName(pendingSetup.businessName);
      }
    }
  }, [open, name, getPendingSetup]);

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent double submission
    if (isLoading) return;

    // Check limit again before creating
    if (limitCheck && !limitCheck.canCreate) {
      toast({
        title: "Limit reached",
        description: "You've reached the maximum number of organizations for your plan.",
        variant: "destructive",
      });
      return;
    }
    
    setIsLoading(true);

    try {
      const slug = generateSlug(name);
      const pendingSetup = getPendingSetup();
      await createOrganization(
        name, 
        slug,
        pendingSetup?.country,
        pendingSetup?.currency,
        pendingSetup?.businessType
      );
      toast({
        title: "Organization created!",
        description: `${name} is ready to use.`,
      });
      clearPendingSetup();
      setName("");
      onOpenChange(false);
      onSuccess?.();
    } catch (error: any) {
      toast({
        title: "Error creating organization",
        description: normalizeError(error).message || "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpgrade = () => {
    onOpenChange(false);
    navigate("/upgrade");
  };

  const showLimitReached = limitCheck && !limitCheck.canCreate && !limitCheck.isUnlimited;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Organization</DialogTitle>
          <DialogDescription>
            Enter a name for your organization. This will be your business workspace.
          </DialogDescription>
        </DialogHeader>

        {isCheckingLimit ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : showLimitReached ? (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                You've reached the maximum of {limitCheck.maxAllowed} organization{limitCheck.maxAllowed !== 1 ? 's' : ''} for your current plan.
                Currently using {limitCheck.currentCount} of {limitCheck.maxAllowed}.
              </AlertDescription>
            </Alert>
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleUpgrade}>
                <ArrowUpCircle className="mr-2 h-4 w-4" />
                Upgrade Plan
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {limitCheck && !limitCheck.isUnlimited && (
              <p className="text-sm text-muted-foreground">
                Organizations: {limitCheck.currentCount} of {limitCheck.maxAllowed} used
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="orgName">Organization Name</Label>
              <Input
                id="orgName"
                placeholder="My Company Inc."
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
              {name && (
                <p className="text-xs text-muted-foreground">
                  URL: accrualflow.app/<span className="font-medium">{generateSlug(name)}</span>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="legalName">Legal Name (optional)</Label>
              <Input
                id="legalName"
                placeholder="Defaults to organization name"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Used on invoices, tax filings, and legal documents.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Workspace Type</Label>
              <RadioGroup
                value={workspaceMode}
                onValueChange={(v) => setWorkspaceMode(v as "single" | "multi")}
                className="space-y-2"
              >
                <label htmlFor="mode-single" className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50">
                  <RadioGroupItem id="mode-single" value="single" className="mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium">Single business</div>
                    <p className="text-xs text-muted-foreground">One legal entity, one set of books. Recommended.</p>
                  </div>
                </label>
                <label htmlFor="mode-multi" className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50">
                  <RadioGroupItem id="mode-multi" value="multi" className="mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium">Multi-business workspace</div>
                    <p className="text-xs text-muted-foreground">
                      Manage multiple legal entities under one login. Each business keeps its own books, currency, and chart of accounts.
                    </p>
                  </div>
                </label>
              </RadioGroup>
            </div>

            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading || !name.trim()}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Organization"
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
