import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useBusinesses, CreateBusinessInput } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { useSubscriptionLimits } from "@/hooks/useSubscriptionLimits";
import { usePermissions } from "@/hooks/usePermissions";
import { Loader2, Building2, AlertCircle, ArrowUpCircle, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useCountries } from "@/hooks/useCountries";
import { useCurrencies } from "@/hooks/useCurrencies";
import { CountryCombobox } from "@/components/contacts/CountryCombobox";
import { CurrencyCombobox } from "@/components/contacts/CurrencyCombobox";

interface CreateBusinessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateBusinessDialog({ open, onOpenChange }: CreateBusinessDialogProps) {
  const { createBusiness, switchBusiness } = useBusinesses();
  const { checkBusinessLimit } = useSubscriptionLimits();
  const { canManageBusiness } = usePermissions();
  const navigate = useNavigate();
  const { countries, isLoading: countriesLoading } = useCountries();
  const { currencies, isLoading: currenciesLoading } = useCurrencies();
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingLimit, setIsCheckingLimit] = useState(false);
  const [limitCheck, setLimitCheck] = useState<{
    canCreate: boolean;
    currentCount: number;
    maxAllowed: number | null;
    isUnlimited: boolean;
  } | null>(null);
  const [formData, setFormData] = useState<CreateBusinessInput>({
    name: "",
    legal_name: "",
    tax_id: "",
    registration_number: "",
    email: "",
    phone: "",
    website: "",
    address: "",
    city: "",
    state: "",
    postal_code: "",
    country: "",
    base_currency: "",
    invoice_prefix: "",
    estimate_prefix: "",
    bill_prefix: "",
  });

  // Check limits when dialog opens
  useEffect(() => {
    if (open) {
      setIsCheckingLimit(true);
      checkBusinessLimit().then((result) => {
        setLimitCheck(result);
        setIsCheckingLimit(false);
      });
    }
  }, [open, checkBusinessLimit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;
    if (!canManageBusiness) return;

    // Check limit again before creating
    if (limitCheck && !limitCheck.canCreate) {
      return;
    }

    setIsLoading(true);
    try {
      const created = await createBusiness(formData);
      // Drop the user into the new company so settings, dashboards, and
      // reports immediately reflect the entity they just created.
      try {
        await switchBusiness(created.id);
      } catch (e) {
        // non-fatal: company was created, only the switch failed
        console.warn("Switch to new company failed", e);
      }
      toast.success(`Company "${created.name}" created`);
      onOpenChange(false);
      setFormData({
        name: "",
        legal_name: "",
        tax_id: "",
        registration_number: "",
        email: "",
        phone: "",
        website: "",
        address: "",
        city: "",
        state: "",
        postal_code: "",
        country: "",
        base_currency: "",
        invoice_prefix: "",
        estimate_prefix: "",
        bill_prefix: "",
      });
    } catch (error) {
      console.error("Error creating business:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const updateField = (field: keyof CreateBusinessInput, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * When the user picks a country, auto-fill the base currency from the
   * countries table — but only if they haven't manually overridden it.
   * Mirrors `complete_onboarding`'s behaviour so the second-company UX
   * matches the first-company UX.
   */
  const handleCountryChange = (code: string) => {
    setFormData((prev) => {
      const matched = countries.find((c) => c.code === code);
      const next: CreateBusinessInput = { ...prev, country: code };
      // Only auto-fill if the suggested currency is an active, supported one.
      const isSupported =
        matched && currencies.some((cur) => cur.code === matched.currency);
      if (matched && isSupported && !prev.base_currency) {
        next.base_currency = matched.currency;
      }
      return next;
    });
  };

  const handleUpgrade = () => {
    onOpenChange(false);
    navigate("/upgrade");
  };

  const showLimitReached = limitCheck && !limitCheck.canCreate && !limitCheck.isUnlimited;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Create New Business
          </DialogTitle>
        </DialogHeader>

        {isCheckingLimit ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !canManageBusiness ? (
          <div className="space-y-4">
            <Alert variant="destructive">
              <ShieldAlert className="h-4 w-4" />
              <AlertDescription>
                You don't have permission to create businesses. Contact your organization admin.
              </AlertDescription>
            </Alert>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            </div>
          </div>
        ) : showLimitReached ? (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                You've reached the maximum of {limitCheck.maxAllowed} business{limitCheck.maxAllowed !== 1 ? 'es' : ''} for your current plan.
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
                Businesses: {limitCheck.currentCount} of {limitCheck.maxAllowed} used
              </p>
            )}

            {/* Basic Information */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-muted-foreground">Basic Information</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Business Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    placeholder="My Business"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="legal_name">Legal Name</Label>
                  <Input
                    id="legal_name"
                    value={formData.legal_name || ""}
                    onChange={(e) => updateField("legal_name", e.target.value)}
                    placeholder="Legal registered name"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="tax_id">Tax ID</Label>
                  <Input
                    id="tax_id"
                    value={formData.tax_id || ""}
                    onChange={(e) => updateField("tax_id", e.target.value)}
                    placeholder="Tax registration number"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="registration_number">Registration Number</Label>
                  <Input
                    id="registration_number"
                    value={formData.registration_number || ""}
                    onChange={(e) => updateField("registration_number", e.target.value)}
                    placeholder="Business registration number"
                  />
                </div>
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
                    placeholder="contact@business.com"
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
              <div className="space-y-2">
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  value={formData.website || ""}
                  onChange={(e) => updateField("website", e.target.value)}
                  placeholder="https://www.business.com"
                />
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
                  <Label htmlFor="country">Country *</Label>
                  <CountryCombobox
                    countries={countries}
                    value={formData.country || ""}
                    onValueChange={handleCountryChange}
                    placeholder="Select country"
                    disabled={countriesLoading}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="base_currency">Base Currency *</Label>
                  <CurrencyCombobox
                    currencies={currencies}
                    value={formData.base_currency || ""}
                    onValueChange={(v) => updateField("base_currency", v)}
                    placeholder="Select currency"
                    disabled={currenciesLoading}
                  />
                  <p className="text-xs text-muted-foreground">
                    Books for this company are kept in this currency. It cannot be
                    changed once transactions are posted.
                  </p>
                </div>
              </div>
            </div>

            {/* Document Prefixes */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-muted-foreground">Document Prefixes</h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="invoice_prefix">Invoice Prefix</Label>
                  <Input
                    id="invoice_prefix"
                    value={formData.invoice_prefix || ""}
                    onChange={(e) => updateField("invoice_prefix", e.target.value)}
                    placeholder="INV"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="estimate_prefix">Estimate Prefix</Label>
                  <Input
                    id="estimate_prefix"
                    value={formData.estimate_prefix || ""}
                    onChange={(e) => updateField("estimate_prefix", e.target.value)}
                    placeholder="EST"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bill_prefix">Bill Prefix</Label>
                  <Input
                    id="bill_prefix"
                    value={formData.bill_prefix || ""}
                    onChange={(e) => updateField("bill_prefix", e.target.value)}
                    placeholder="BILL"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  isLoading ||
                  !formData.name.trim() ||
                  !formData.country ||
                  !formData.base_currency
                }
              >
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Business
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
