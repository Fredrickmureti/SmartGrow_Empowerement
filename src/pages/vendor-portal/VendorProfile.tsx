import { normalizeError } from "@/services/resilience";
/**
 * Vendor Portal - Editable Profile
 */
import { useState, useEffect } from "react";
import { useVendorPortal } from "@/hooks/useVendorPortal";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { User, Mail, Building, Save, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ContactFields {
  phone: string;
  company: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  tax_id: string;
}

export default function VendorProfile() {
  const { portalData } = useVendorPortal();
  const { user } = useAuth();
  const [isSaving, setIsSaving] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isLoadingContact, setIsLoadingContact] = useState(true);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [fields, setFields] = useState<ContactFields>({
    phone: "",
    company: "",
    address_line1: "",
    address_line2: "",
    city: "",
    state: "",
    postal_code: "",
    country: "",
    tax_id: "",
  });

  useEffect(() => {
    if (portalData.contactId) fetchContact();
  }, [portalData.contactId]);

  const fetchContact = async () => {
    if (!portalData.contactId) return;
    setIsLoadingContact(true);
    const { data: rawData } = await (supabase as any)
      .from("contacts")
      .select("phone, parent_contact:contacts!parent_contact_id(name), address_line1, address_line2, city, state, postal_code, country, tax_id")
      .eq("id", portalData.contactId)
      .single();

    const data = rawData as null | {
      phone: string | null;
      parent_contact: { name: string | null } | null;
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      country: string | null;
      tax_id: string | null;
    };

    if (data) {
      setFields({
        phone: data.phone || "",
        company: data.parent_contact?.name || "",
        address_line1: data.address_line1 || "",
        address_line2: data.address_line2 || "",
        city: data.city || "",
        state: data.state || "",
        postal_code: data.postal_code || "",
        country: data.country || "",
        tax_id: data.tax_id || "",
      });
    }
    setIsLoadingContact(false);
  };

  const handleSave = async () => {
    if (!portalData.contactId) return;
    setIsSaving(true);

    // The `company` field is no longer persisted on the contact directly — it
    // lives on the parent_contact relation. Portal users editing their own
    // contact card can only update their personal/address fields here; the
    // company linkage is managed by the buyer-side AP team.
    const { error } = await (supabase as any)
      .from("contacts")
      .update({
        phone: fields.phone || null,
        address_line1: fields.address_line1 || null,
        address_line2: fields.address_line2 || null,
        city: fields.city || null,
        state: fields.state || null,
        postal_code: fields.postal_code || null,
        country: fields.country || null,
        tax_id: fields.tax_id || null,
      })
      .eq("id", portalData.contactId);

    if (error) {
      toast.error("Failed to save: " + normalizeError(error).message);
    } else {
      toast.success("Profile updated successfully");
    }
    setIsSaving(false);
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setIsChangingPassword(true);

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      toast.error("Failed to change password: " + normalizeError(error).message);
    } else {
      toast.success("Password changed successfully");
      setNewPassword("");
      setConfirmPassword("");
    }
    setIsChangingPassword(false);
  };

  const updateField = (key: keyof ContactFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold text-foreground">Your Profile</h2>

      {/* Account Info (read-only) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Account Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <User className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <Label className="text-xs text-muted-foreground">Name</Label>
              <p className="text-sm font-medium">{portalData.contactName || "—"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Mail className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <Label className="text-xs text-muted-foreground">Email</Label>
              <p className="text-sm font-medium">{user?.email || "—"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Building className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <Label className="text-xs text-muted-foreground">Organization</Label>
              <p className="text-sm font-medium">{portalData.organizationName || "—"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Editable Contact Details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Contact Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoadingContact ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <Input value={fields.phone} onChange={(e) => updateField("phone", e.target.value)} placeholder="Phone number" />
                </div>
                <div className="space-y-2">
                  <Label>Company</Label>
                  <Input value={fields.company} onChange={(e) => updateField("company", e.target.value)} placeholder="Company name" />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>Address Line 1</Label>
                <Input value={fields.address_line1} onChange={(e) => updateField("address_line1", e.target.value)} placeholder="Street address" />
              </div>
              <div className="space-y-2">
                <Label>Address Line 2</Label>
                <Input value={fields.address_line2} onChange={(e) => updateField("address_line2", e.target.value)} placeholder="Suite, unit, etc." />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>City</Label>
                  <Input value={fields.city} onChange={(e) => updateField("city", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>State</Label>
                  <Input value={fields.state} onChange={(e) => updateField("state", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Postal Code</Label>
                  <Input value={fields.postal_code} onChange={(e) => updateField("postal_code", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Country</Label>
                  <Input value={fields.country} onChange={(e) => updateField("country", e.target.value)} />
                </div>
              </div>

              <Separator />

              <div className="space-y-2 max-w-xs">
                <Label>Tax ID / VAT Number</Label>
                <Input value={fields.tax_id} onChange={(e) => updateField("tax_id", e.target.value)} placeholder="Tax identification number" />
              </div>

              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save Changes
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Password Change */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Lock className="h-5 w-5" /> Change Password
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>New Password</Label>
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 6 characters" />
            </div>
            <div className="space-y-2">
              <Label>Confirm Password</Label>
              <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Repeat password" />
            </div>
          </div>
          <Button onClick={handleChangePassword} disabled={isChangingPassword || !newPassword} variant="outline">
            {isChangingPassword ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Lock className="h-4 w-4 mr-2" />}
            Change Password
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
