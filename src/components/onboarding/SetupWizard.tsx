// @ts-nocheck
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  Upload,
  Calculator,
  Users,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  Image,
  FileSpreadsheet,
  Loader2,
} from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface SetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

interface WizardStep {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
}

const WIZARD_STEPS: WizardStep[] = [
  {
    id: "business",
    title: "Business Details",
    description: "Add your business information",
    icon: Building2,
  },
  {
    id: "logo",
    title: "Upload Logo",
    description: "Brand your invoices",
    icon: Image,
  },
  {
    id: "chart-of-accounts",
    title: "Chart of Accounts",
    description: "Set up your accounting",
    icon: FileSpreadsheet,
  },
  {
    id: "invite-team",
    title: "Invite Team",
    description: "Add team members",
    icon: Users,
  },
];

export function SetupWizard({ open, onOpenChange, onComplete }: SetupWizardProps) {
  const navigate = useNavigate();
  const { currentOrg, refreshOrganizations } = useOrganization();
  const { currentBusiness, updateBusiness } = useBusinesses();
  const { toast } = useToast();

  const [currentStep, setCurrentStep] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [coaProvisioned, setCoaProvisioned] = useState(false);

  // Auto-detect if CoA already exists (provisioned during onboarding)
  useEffect(() => {
    async function checkExistingCoA() {
      if (!currentOrg || !currentBusiness) return;
      const { count } = await supabase
        .from("accounts")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);
      if (count && count > 0) {
        setCoaProvisioned(true);
      }
    }
    checkExistingCoA();
  }, [currentOrg?.id, currentBusiness?.id]);

  // Business details
  const [businessData, setBusinessData] = useState({
    legalName: "",
    taxId: "",
    address: "",
    phone: "",
    email: "",
    website: "",
  });

  // Logo
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  // Team invites
  const [teamEmails, setTeamEmails] = useState("");

  useEffect(() => {
    if (currentBusiness) {
      setBusinessData({
        legalName: currentBusiness.legal_name || "",
        taxId: currentBusiness.tax_id || "",
        address: currentBusiness.address || "",
        phone: currentBusiness.phone || "",
        email: currentBusiness.email || "",
        website: currentBusiness.website || "",
      });
    }
  }, [currentBusiness]);

  const progress = ((currentStep + 1) / WIZARD_STEPS.length) * 100;

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setLogoFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setLogoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSaveBusinessDetails = async () => {
    if (!currentBusiness) return;
    setIsLoading(true);
    try {
      await updateBusiness(currentBusiness.id, {
        legal_name: businessData.legalName || null,
        tax_id: businessData.taxId || null,
        address: businessData.address || null,
        phone: businessData.phone || null,
        email: businessData.email || null,
        website: businessData.website || null,
      });
      toast({ title: "Business details saved" });
      setCurrentStep(1);
    } catch (error: any) {
      toast({
        title: "Error saving business details",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleUploadLogo = async () => {
    if (!logoFile || !currentOrg || !currentBusiness) {
      setCurrentStep(2);
      return;
    }

    setIsLoading(true);
    try {
      // Per Odoo res.company model: the logo lives on the legal entity
      // (businesses), not the workspace. Path matches BusinessLogoUpload's
      // `{org_id}/business/{business_id}/logo.{ext}` convention so the
      // existing storage RLS policies apply unchanged.
      const fileExt = (logoFile.name.split(".").pop() || "png").toLowerCase();
      const fileName = `${currentOrg.id}/business/${currentBusiness.id}/logo.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("organization-assets")
        .upload(fileName, logoFile, { upsert: true, contentType: logoFile.type });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from("organization-assets")
        .getPublicUrl(fileName);
      const urlWithCacheBuster = `${urlData.publicUrl}?t=${Date.now()}`;

      await supabase
        .from("businesses")
        .update({ logo_url: urlWithCacheBuster })
        .eq("id", currentBusiness.id);

      await refreshOrganizations();
      toast({ title: "Logo uploaded successfully" });
      setCurrentStep(2);
    } catch (error: any) {
      toast({
        title: "Error uploading logo",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleProvisionChartOfAccounts = async () => {
    if (!currentOrg || !currentBusiness || coaProvisioned) {
      setCurrentStep(3);
      return;
    }

    setIsLoading(true);
    try {
      const countryCode = currentBusiness.country || "INT";
      const { data, error } = await supabase.rpc("provision_default_chart_of_accounts", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _country_code: countryCode,
      });

      if (error) throw error;

      setCoaProvisioned(true);
      toast({
        title: "Chart of Accounts created",
        description: `${data} accounts have been set up based on ${countryCode.toUpperCase()} standards.`,
      });
      setCurrentStep(3);
    } catch (error: any) {
      toast({
        title: "Error creating chart of accounts",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleInviteTeam = async () => {
    // Skip if no emails entered
    if (!teamEmails.trim()) {
      handleComplete();
      return;
    }

    setIsLoading(true);
    try {
      // Parse emails and send invites
      const emails = teamEmails
        .split(/[,\n]/)
        .map((e) => e.trim())
        .filter((e) => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

      if (emails.length === 0) {
        toast({
          title: "No valid emails",
          description: "Please enter valid email addresses to invite.",
          variant: "destructive",
        });
        setIsLoading(false);
        return;
      }

      // Create invitations for each email
      let successCount = 0;
      let failCount = 0;

      for (const email of emails) {
        try {
          // Create invitation in database
          const { data: invitation, error: invError } = await supabase
            .from("organization_invitations")
            .insert({
              organization_id: currentOrg?.id!,
              email,
              role: "staff" as const,
              user_type: "internal",
              expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            })
            .select()
            .single();

          if (invError) throw invError;

          // Send invitation email
          const { error: emailError } = await supabase.functions.invoke("send-invitation-email", {
            body: { invitationId: invitation.id },
          });

          if (emailError) {
            console.error("Error sending invitation email:", emailError);
            // Invitation was created, email just failed - still count as success
          }

          successCount++;
        } catch (error) {
          console.error(`Error inviting ${email}:`, error);
          failCount++;
        }
      }

      if (successCount > 0) {
        toast({
          title: "Invitations sent!",
          description: `Successfully invited ${successCount} team member${successCount > 1 ? "s" : ""}.${failCount > 0 ? ` ${failCount} failed.` : ""}`,
        });
      } else {
        toast({
          title: "Failed to send invitations",
          description: "Please try again or invite team members from Settings.",
          variant: "destructive",
        });
      }

      handleComplete();
    } catch (error: any) {
      toast({
        title: "Error inviting team",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleComplete = async () => {
    if (!currentOrg) return;

    try {
      await supabase
        .from("organizations")
        .update({
          setup_wizard_completed: true,
          setup_wizard_step: WIZARD_STEPS.length,
        })
        .eq("id", currentOrg.id);

      toast({
        title: "Setup complete! 🎉",
        description: "Your organization is ready to use.",
      });
      onComplete?.();
      onOpenChange(false);
    } catch (error) {
      console.error("Error completing wizard:", error);
    }
  };

  const handleSkip = () => {
    if (currentStep < WIZARD_STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 0: // Business Details
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="legalName">Legal Business Name</Label>
                <Input
                  id="legalName"
                  placeholder="Acme Corporation Ltd"
                  value={businessData.legalName}
                  onChange={(e) =>
                    setBusinessData({ ...businessData, legalName: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="taxId">Tax ID / Registration Number</Label>
                <Input
                  id="taxId"
                  placeholder="P051234567X"
                  value={businessData.taxId}
                  onChange={(e) =>
                    setBusinessData({ ...businessData, taxId: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="address">Business Address</Label>
              <Textarea
                id="address"
                placeholder="123 Business Street, City, Country"
                value={businessData.address}
                onChange={(e) =>
                  setBusinessData({ ...businessData, address: e.target.value })
                }
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  placeholder="+254 700 123456"
                  value={businessData.phone}
                  onChange={(e) =>
                    setBusinessData({ ...businessData, phone: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="info@company.com"
                  value={businessData.email}
                  onChange={(e) =>
                    setBusinessData({ ...businessData, email: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="website">Website (optional)</Label>
              <Input
                id="website"
                placeholder="https://company.com"
                value={businessData.website}
                onChange={(e) =>
                  setBusinessData({ ...businessData, website: e.target.value })
                }
              />
            </div>
          </div>
        );

      case 1: // Logo
        return (
          <div className="space-y-6">
            <div className="flex flex-col items-center justify-center">
              {logoPreview ? (
                <div className="relative">
                  <img
                    src={logoPreview}
                    alt="Logo preview"
                    className="w-32 h-32 object-contain rounded-lg border"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="absolute -bottom-2 -right-2"
                    onClick={() => {
                      setLogoFile(null);
                      setLogoPreview(null);
                    }}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <label className="cursor-pointer">
                  <div className="w-32 h-32 rounded-lg border-2 border-dashed border-muted-foreground/25 flex flex-col items-center justify-center hover:border-primary/50 transition-colors">
                    <Upload className="h-8 w-8 text-muted-foreground mb-2" />
                    <span className="text-sm text-muted-foreground">Upload Logo</span>
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleLogoChange}
                  />
                </label>
              )}
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Your logo will appear on invoices, estimates, and other documents.
              <br />
              Recommended size: 400x400 pixels (PNG or JPG)
            </p>
          </div>
        );

      case 2: // Chart of Accounts
        return (
          <div className="space-y-6">
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Calculator className="h-8 w-8 text-primary" />
              </div>
              <h3 className="font-semibold mb-2">Set Up Your Chart of Accounts</h3>
              <p className="text-sm text-muted-foreground">
                We'll create a standard chart of accounts based on your country's
                accounting standards. You can customize it later.
              </p>
            </div>
            {coaProvisioned ? (
              <Card className="border-success/50 bg-success/5">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-success" />
                    <span className="font-medium">Chart of Accounts created!</span>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">
                        {currentBusiness?.country
                          ? `${currentBusiness.country.toUpperCase()} Standard COA`
                          : "International Standard COA"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Includes standard tax and statutory accounts for your country
                      </p>
                    </div>
                    <Badge variant="secondary">Recommended</Badge>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        );

      case 3: // Invite Team
        return (
          <div className="space-y-6">
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Users className="h-8 w-8 text-primary" />
              </div>
              <h3 className="font-semibold mb-2">Invite Your Team</h3>
              <p className="text-sm text-muted-foreground">
                Add team members to collaborate on invoicing, expenses, and reports.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="teamEmails">Email Addresses</Label>
              <Textarea
                id="teamEmails"
                placeholder="Enter email addresses (one per line or comma-separated)"
                value={teamEmails}
                onChange={(e) => setTeamEmails(e.target.value)}
                rows={4}
              />
              <p className="text-xs text-muted-foreground">
                Team members will receive an invitation to join your organization.
              </p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const handleNext = () => {
    switch (currentStep) {
      case 0:
        handleSaveBusinessDetails();
        break;
      case 1:
        handleUploadLogo();
        break;
      case 2:
        handleProvisionChartOfAccounts();
        break;
      case 3:
        handleInviteTeam();
        break;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <DialogTitle>Setup Wizard</DialogTitle>
          </div>
          <DialogDescription>
            Let's get your organization set up in a few quick steps.
          </DialogDescription>
        </DialogHeader>

        {/* Progress */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Step {currentStep + 1} of {WIZARD_STEPS.length}
            </span>
            <span className="font-medium">{WIZARD_STEPS[currentStep].title}</span>
          </div>
          <Progress value={progress} className="h-2" />
          
          {/* Step indicators */}
          <div className="flex justify-between">
            {WIZARD_STEPS.map((step, index) => (
              <div
                key={step.id}
                className={`flex flex-col items-center gap-1 ${
                  index <= currentStep ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    index < currentStep
                      ? "bg-primary text-primary-foreground"
                      : index === currentStep
                      ? "bg-primary/10 text-primary border-2 border-primary"
                      : "bg-muted"
                  }`}
                >
                  {index < currentStep ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <step.icon className="h-4 w-4" />
                  )}
                </div>
                <span className="text-xs hidden sm:block">{step.title}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Step Content */}
        <div className="min-h-[280px] py-4">{renderStepContent()}</div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-4 border-t">
          <div>
            {currentStep > 0 && (
              <Button
                variant="ghost"
                onClick={() => setCurrentStep(currentStep - 1)}
                disabled={isLoading}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={handleSkip} disabled={isLoading}>
              Skip
            </Button>
            <Button onClick={handleNext} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : currentStep === WIZARD_STEPS.length - 1 ? (
                <>
                  Complete Setup
                  <CheckCircle2 className="h-4 w-4 ml-2" />
                </>
              ) : (
                <>
                  Continue
                  <ChevronRight className="h-4 w-4 ml-1" />
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
