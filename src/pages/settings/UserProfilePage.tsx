/**
 * Generic User Profile Page — App-Independent
 * 
 * This is the user's account profile, NOT the HR employee profile.
 * It works regardless of whether HR/Payroll is installed.
 * If the user has an employee record AND HR is installed, a link
 * to the HR employee portal is shown.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/hooks/useUserProfile";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { UserAvatarUpload } from "@/components/profile/UserAvatarUpload";
import { getDisplayName } from "@/lib/user-display-name";
import { Link } from "react-router-dom";
import { useState } from "react";
import { Building2, Mail, Phone, User, Briefcase, ArrowRight } from "lucide-react";
import { toast } from "sonner";

export default function UserProfilePage() {
  const { user } = useAuth();
  const { profile, updateProfile, refreshProfile, isLoading } = useUserProfile();
  const { currentEmployee } = useCurrentEmployee();
  const { isInstalled } = useInstalledApps();
  const { currentOrg, userRole } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { displayName, initials } = getDisplayName(currentEmployee, profile, user);

  const avatarUrl = (currentEmployee as any)?.avatar_url || profile?.avatar_url || null;

  const [fullName, setFullName] = useState(profile?.full_name || "");
  const [phone, setPhone] = useState(profile?.phone || "");
  const [saving, setSaving] = useState(false);

  // Sync state when profile loads
  const [synced, setSynced] = useState(false);
  if (profile && !synced) {
    setFullName(profile.full_name || "");
    setPhone(profile.phone || "");
    setSynced(true);
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProfile({ full_name: fullName.trim(), phone: phone.trim() || null });
    } catch {
      // handled in hook
    } finally {
      setSaving(false);
    }
  };

  const hasHrApp = isInstalled("hr");
  const hasEmployeeRecord = !!currentEmployee;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="container max-w-2xl py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">My Profile</h1>
        <p className="text-muted-foreground">Manage your account information</p>
      </div>

      {/* Avatar & Name Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4">
            {user && (
              <UserAvatarUpload
                userId={user.id}
                currentAvatarUrl={avatarUrl}
                initials={initials}
                displayName={displayName}
                onAvatarChange={() => refreshProfile()}
              />
            )}
            <div className="text-center">
              <h2 className="text-lg font-semibold text-foreground">{displayName}</h2>
              <p className="text-sm text-muted-foreground">{user?.email}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Editable Profile Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <User className="h-4 w-4" />
            Account Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fullName">Full Name</Label>
            <Input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Enter your full name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <Input
                id="email"
                value={user?.email || ""}
                disabled
                className="bg-muted"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              This is your login email and cannot be changed here.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-muted-foreground" />
              <Input
                id="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Enter your phone number"
              />
            </div>
          </div>

          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </CardContent>
      </Card>

      {/* Organization Info */}
      {currentOrg && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              {currentBusiness ? "Company" : "Organization"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
                {/* Per-company logo only (Odoo res.company model). */}
                {currentBusiness?.logo_url ? (
                  <img src={currentBusiness.logo_url} alt="" className="h-8 w-8 rounded-md object-cover" />
                ) : (
                  <span className="text-sm font-bold text-primary">
                    {(currentBusiness?.name || currentOrg.name)?.charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <div>
                <p className="font-medium text-foreground">{currentBusiness?.name || currentOrg.name}</p>
                <p className="text-sm text-muted-foreground capitalize">{typeof userRole === 'string' ? userRole : userRole?.role || "Member"}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* HR Employee Link - only if HR is installed AND user has employee record */}
      {hasHrApp && hasEmployeeRecord && (
        <>
          <Separator />
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Briefcase className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-foreground">Employee Profile</p>
                    <p className="text-sm text-muted-foreground">
                      View your HR details, payslips, and leave requests
                    </p>
                  </div>
                </div>
                <Button variant="outline" asChild>
                  <Link to="/me">
                    View <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
