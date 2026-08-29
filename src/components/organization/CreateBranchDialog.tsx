import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useBranches, CreateBranchInput } from "@/hooks/useBranches";
import { useEntityCreationLimits } from "@/hooks/useEntityCreationLimits";
import { Loader2, MapPin, AlertCircle, ArrowUpCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface CreateBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessId: string;
}

export function CreateBranchDialog({ open, onOpenChange, businessId }: CreateBranchDialogProps) {
  const { createBranch } = useBranches();
  const { checkBranchLimit } = useEntityCreationLimits();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingLimit, setIsCheckingLimit] = useState(false);
  const [limitCheck, setLimitCheck] = useState<{
    canCreate: boolean;
    currentCount: number;
    maxAllowed: number | null;
    isUnlimited: boolean;
  } | null>(null);
  const [formData, setFormData] = useState<Omit<CreateBranchInput, "business_id">>({
    name: "",
    code: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    postal_code: "",
    country: "",
    is_headquarters: false,
  });

  // Check limits when dialog opens
  useEffect(() => {
    if (open && businessId) {
      setIsCheckingLimit(true);
      checkBranchLimit(businessId).then((result) => {
        setLimitCheck(result);
        setIsCheckingLimit(false);
      });
    }
  }, [open, businessId, checkBranchLimit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;

    // Check limit again before creating
    if (limitCheck && !limitCheck.canCreate) {
      return;
    }

    setIsLoading(true);
    try {
      await createBranch({
        ...formData,
      });
      onOpenChange(false);
      setFormData({
        name: "",
        code: "",
        email: "",
        phone: "",
        address: "",
        city: "",
        state: "",
        postal_code: "",
        country: "",
        is_headquarters: false,
      });
    } catch (error) {
      console.error("Error creating branch:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const updateField = <K extends keyof Omit<CreateBranchInput, "business_id">>(
    field: K,
    value: Omit<CreateBranchInput, "business_id">[K]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleUpgrade = () => {
    onOpenChange(false);
    navigate("/upgrade");
  };

  const showLimitReached = limitCheck && !limitCheck.canCreate && !limitCheck.isUnlimited;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Create New Branch
          </DialogTitle>
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
                You've reached the maximum of {limitCheck.maxAllowed} branch{limitCheck.maxAllowed !== 1 ? 'es' : ''} for your current plan.
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
          <form onSubmit={handleSubmit} className="space-y-6">
            {limitCheck && !limitCheck.isUnlimited && (
              <p className="text-sm text-muted-foreground">
                Branches: {limitCheck.currentCount} of {limitCheck.maxAllowed} used
              </p>
            )}

            {/* Basic Information */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Branch Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    placeholder="Main Office"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code">Branch Code</Label>
                  <Input
                    id="code"
                    value={formData.code || ""}
                    onChange={(e) => updateField("code", e.target.value)}
                    placeholder="HQ, BR01, etc."
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="is_headquarters">Headquarters</Label>
                  <p className="text-sm text-muted-foreground">
                    Mark this as the main branch
                  </p>
                </div>
                <Switch
                  id="is_headquarters"
                  checked={formData.is_headquarters}
                  onCheckedChange={(checked) => updateField("is_headquarters", checked)}
                />
              </div>
            </div>

            {/* Contact Information */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-muted-foreground">Contact Information</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email || ""}
                    onChange={(e) => updateField("email", e.target.value)}
                    placeholder="branch@business.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={formData.phone || ""}
                    onChange={(e) => updateField("phone", e.target.value)}
                    placeholder="+1 234 567 8900"
                  />
                </div>
              </div>
            </div>

            {/* Address */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-muted-foreground">Address</h3>
              <div className="space-y-2">
                <Label htmlFor="address">Street Address</Label>
                <Textarea
                  id="address"
                  value={formData.address || ""}
                  onChange={(e) => updateField("address", e.target.value)}
                  placeholder="Street address"
                  rows={2}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={formData.city || ""}
                    onChange={(e) => updateField("city", e.target.value)}
                    placeholder="City"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State/Province</Label>
                  <Input
                    id="state"
                    value={formData.state || ""}
                    onChange={(e) => updateField("state", e.target.value)}
                    placeholder="State"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="postal_code">Postal Code</Label>
                  <Input
                    id="postal_code"
                    value={formData.postal_code || ""}
                    onChange={(e) => updateField("postal_code", e.target.value)}
                    placeholder="12345"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">Country</Label>
                  <Input
                    id="country"
                    value={formData.country || ""}
                    onChange={(e) => updateField("country", e.target.value)}
                    placeholder="Country"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading || !formData.name.trim()}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Branch
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
