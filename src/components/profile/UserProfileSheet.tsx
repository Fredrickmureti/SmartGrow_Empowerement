import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useUserProfile } from "@/hooks/useUserProfile";
import { UserAvatarUpload } from "@/components/profile/UserAvatarUpload";
import { LogOut, Settings, User, Mail, Hash, Phone, Info, Pencil, Check, X } from "lucide-react";
import { getDisplayName } from "@/lib/user-display-name";

interface UserProfileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function InlineEditField({
  label,
  value,
  onSave,
  icon: Icon,
}: {
  label: string;
  value: string;
  onSave: (val: string) => Promise<void>;
  icon: React.ElementType;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (draft.trim() === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch {
      // error handled in hook
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-8 text-sm"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") handleCancel();
          }}
          disabled={saving}
        />
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={handleSave} disabled={saving}>
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={handleCancel} disabled={saving}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-2 py-2 rounded-md group cursor-pointer hover:bg-secondary/50" onClick={() => { setDraft(value); setEditing(true); }}>
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium truncate">{value || "Not set"}</p>
      </div>
      <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </div>
  );
}

export function UserProfileSheet({ open, onOpenChange }: UserProfileSheetProps) {
  const { user, signOut } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const { profile, updateProfile, refreshProfile } = useUserProfile();
  const navigate = useNavigate();
  const { userType } = useSession();
  const isPortalUser = userType === "portal";
  const profileHref = isPortalUser ? "/me/profile" : "/settings/profile";
  const settingsHref = isPortalUser ? "/me/settings" : "/settings";

  const { displayName, initials } = getDisplayName(currentEmployee, profile, user);

  // Avatar priority: employee avatar > profile avatar > null
  const avatarUrl = (currentEmployee as any)?.avatar_url || profile?.avatar_url || null;

  const handleSignOut = async () => {
    onOpenChange(false);
    await signOut();
  };

  const handleNavigate = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  const handleAvatarChange = (url: string) => {
    refreshProfile();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[340px] sm:w-[400px] flex flex-col overflow-hidden">
        <SheetHeader className="text-left">
          <SheetTitle className="text-base">My Profile</SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col pb-4">
            {/* Avatar & Name Section */}
            <div className="flex flex-col items-center gap-3 py-6">
              {user && (
                <UserAvatarUpload
                  userId={user.id}
                  currentAvatarUrl={avatarUrl}
                  initials={initials}
                  displayName={displayName}
                  onAvatarChange={handleAvatarChange}
                />
              )}
              <div className="text-center">
                <h3 className="text-lg font-semibold text-foreground">{displayName}</h3>
              </div>
            </div>

            <Separator />

            {/* Editable Info Section */}
            <div className="space-y-1 py-4">
              {/* Name - editable */}
              <InlineEditField
                label="Full Name"
                value={profile?.full_name || user?.user_metadata?.full_name || ""}
                onSave={(val) => updateProfile({ full_name: val })}
                icon={User}
              />

              {/* Email - read-only with tooltip */}
              <div className="flex items-center gap-3 px-2 py-2 rounded-md">
                <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="text-sm font-medium truncate">{user?.email}</p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-[200px]">
                    This is your login email and appears on business documents like invoices
                  </TooltipContent>
                </Tooltip>
              </div>

              {/* Phone - editable */}
              <InlineEditField
                label="Phone"
                value={profile?.phone || ""}
                onSave={(val) => updateProfile({ phone: val })}
                icon={Phone}
              />

              {/* Employee-specific info (read-only) */}
              {currentEmployee && (
                <>
                  <Separator className="my-2" />
                  <p className="text-xs text-muted-foreground px-2 py-1 font-medium">Employee Details</p>
                  {currentEmployee.employee_number && (
                    <div className="flex items-center gap-3 px-2 py-2 rounded-md">
                      <Hash className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Employee #</p>
                        <p className="text-sm font-medium truncate">{currentEmployee.employee_number}</p>
                      </div>
                    </div>
                  )}
                  {currentEmployee.email && currentEmployee.email !== user?.email && (
                    <div className="flex items-center gap-3 px-2 py-2 rounded-md">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Work Email</p>
                        <p className="text-sm font-medium truncate">{currentEmployee.email}</p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <Separator />

            {/* Quick Actions */}
            <div className="space-y-1 py-4">
              <Button
                variant="ghost"
                className="w-full justify-start gap-3"
                onClick={() => handleNavigate(profileHref)}
              >
                <User className="h-4 w-4" />
                View Full Profile
              </Button>
              <Button
                variant="ghost"
                className="w-full justify-start gap-3"
                onClick={() => handleNavigate(settingsHref)}
              >
                <Settings className="h-4 w-4" />
                Settings
              </Button>
              <Separator />
              <Button
                variant="ghost"
                className="w-full justify-start gap-3 text-destructive hover:text-destructive"
                onClick={handleSignOut}
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </Button>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
