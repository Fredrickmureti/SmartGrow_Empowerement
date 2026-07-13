import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { usePlatformTeam, PlatformAdmin, PlatformInvitation } from "@/hooks/usePlatformTeam";
import { usePlatformGroups } from "@/hooks/usePlatformGroups";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { useCountryScopes } from "@/hooks/useCountryScopes";
import { useCountries } from "@/hooks/useCountries";
import { OwnershipTransferDialog, AcceptOwnershipBanner } from "@/components/admin/OwnershipTransferDialog";
import { PersonaConflictsCard } from "@/components/admin/PersonaConflictsCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus, Shield, ShieldCheck, ShieldAlert, MoreVertical, UserMinus, RefreshCw, Globe, Clock, X, Send } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

const roleBadgeVariant: Record<string, "default" | "secondary" | "outline"> = {
  owner: "default",
  admin: "secondary",
  operator: "outline",
};

const roleIcon: Record<string, any> = {
  owner: ShieldAlert,
  admin: ShieldCheck,
  operator: Shield,
};

export default function AdminTeam() {
  const navigate = useNavigate();
  const { admins, invitations, isLoading, fetchTeam, cancelInvitation, resendInvitation, deactivateAdmin, reactivateAdmin, updateAdminRole, updateAdminGroups } = usePlatformTeam();
  const { groups, fetchGroups } = usePlatformGroups();
  const { isOwner, hasPerm, refresh: refreshPerms } = usePlatformPermissions();
  const { scopes: allScopes, fetchScopes } = useCountryScopes();
  const { countries } = useCountries();

  useEffect(() => {
    fetchTeam();
    fetchGroups();
    fetchScopes();
  }, []);

  const openScopeEditor = (admin: PlatformAdmin) =>
    navigate(`/admin-management/team/${admin.id}/edit`);

  const canManageTeam = isOwner || hasPerm("team.manage");
  const activeAdmins = admins.filter(a => a.is_active);
  const inactiveAdmins = admins.filter(a => !a.is_active);

  const getAdminScopes = (adminId: string) => allScopes.filter(s => s.admin_id === adminId);

  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        {/* Accept ownership banner for non-owners who have a pending transfer */}
        <AcceptOwnershipBanner onAccepted={() => { fetchTeam(); refreshPerms(); }} />

        {/* Persona conflicts (legacy users who are both platform admin and tenant member) */}
        {isOwner && <PersonaConflictsCard />}

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg sm:text-xl lg:text-2xl font-bold tracking-tight">Platform Team</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">Manage internal platform administrators and operators</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isOwner && (
              <OwnershipTransferDialog admins={admins} onComplete={() => { fetchTeam(); refreshPerms(); }} />
            )}
            {canManageTeam && (
              <Button onClick={() => navigate("/admin-management/team/invite")}>
                <UserPlus className="h-4 w-4 mr-2" /> Invite Member
              </Button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : (
          <>
            {/* Pending Invitations */}
            {invitations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    Pending Invitations ({invitations.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {invitations.map(inv => (
                    <div key={inv.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg border bg-muted/30">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10">
                          <AvatarFallback>{inv.email.charAt(0).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-sm">{inv.email}</span>
                            <Badge variant="outline" className="text-[10px]">{inv.role}</Badge>
                            <Badge variant="secondary" className="text-[10px] gap-0.5">
                              <Clock className="h-2.5 w-2.5" />
                              Expires {format(new Date(inv.expires_at), "MMM d")}
                            </Badge>
                          </div>
                          {inv.country_codes.length > 0 && (
                            <div className="flex items-center gap-1 mt-1">
                              <Globe className="h-3 w-3 text-muted-foreground" />
                              <span className="text-[10px] text-muted-foreground">
                                {inv.country_codes.join(", ")}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                      {canManageTeam && (
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => resendInvitation(inv.id)} title="Resend">
                            <Send className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => cancelInvitation(inv.id)} title="Cancel">
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Active Members ({activeAdmins.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeAdmins.map(admin => (
                  <AdminRow
                    key={admin.id}
                    admin={admin}
                    isOwner={isOwner}
                    canManage={canManageTeam}
                    onDeactivate={() => deactivateAdmin(admin.id)}
                    onRoleChange={(role) => updateAdminRole(admin.id, role)}
                    groups={groups}
                    onGroupsChange={(groupIds) => updateAdminGroups(admin.id, groupIds)}
                    countryScopes={getAdminScopes(admin.id)}
                    countries={countries}
                    onEditScopes={() => openScopeEditor(admin)}
                  />
                ))}
              </CardContent>
            </Card>

            {inactiveAdmins.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg text-muted-foreground">Deactivated ({inactiveAdmins.length})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {inactiveAdmins.map(admin => (
                    <AdminRow
                      key={admin.id}
                      admin={admin}
                      isOwner={isOwner}
                      canManage={canManageTeam}
                      onReactivate={() => reactivateAdmin(admin.id)}
                      groups={groups}
                      countryScopes={[]}
                      countries={countries}
                      inactive
                    />
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )}

      </div>
    </>
  );
}

function AdminRow({
  admin,
  isOwner,
  canManage,
  onDeactivate,
  onReactivate,
  onRoleChange,
  onGroupsChange,
  groups,
  countryScopes,
  countries,
  onEditScopes,
  inactive,
}: {
  admin: PlatformAdmin;
  isOwner: boolean;
  canManage: boolean;
  onDeactivate?: () => void;
  onReactivate?: () => void;
  onRoleChange?: (role: "admin" | "operator") => void;
  onGroupsChange?: (groupIds: string[]) => void;
  groups: any[];
  countryScopes: { country_code: string }[];
  countries: { code: string; name: string }[];
  onEditScopes?: () => void;
  inactive?: boolean;
}) {
  const RoleIcon = roleIcon[admin.role] || Shield;
  const isOwnerRow = admin.role === "owner";
  const countryMap = new Map(countries.map(c => [c.code, c.name]));

  return (
    <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border ${inactive ? "opacity-60 bg-muted/30" : "bg-card"}`}>
      <div className="flex items-center gap-3">
        <Avatar className="h-10 w-10">
          <AvatarImage src={admin.avatar_url} />
          <AvatarFallback>{(admin.full_name || admin.email || "?").charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{admin.full_name || admin.email}</span>
            <Badge variant={roleBadgeVariant[admin.role] || "outline"} className="text-[10px] gap-1">
              <RoleIcon className="h-3 w-3" />
              {admin.role}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{admin.email}</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {admin.groups && admin.groups.map(g => (
              <Badge key={g.id} variant="outline" className="text-[10px]">{g.name}</Badge>
            ))}
            {countryScopes.length > 0 && (
              <Badge variant="secondary" className="text-[10px] gap-0.5">
                <Globe className="h-2.5 w-2.5" />
                {countryScopes.map(s => countryMap.get(s.country_code) || s.country_code).join(", ")}
              </Badge>
            )}
            {isOwnerRow && (
              <Badge variant="secondary" className="text-[10px] gap-0.5">
                <Globe className="h-2.5 w-2.5" />
                Global
              </Badge>
            )}
            {!isOwnerRow && admin.role === "admin" && countryScopes.length === 0 && !inactive && (
              <Badge variant="secondary" className="text-[10px] gap-0.5">
                <Globe className="h-2.5 w-2.5" />
                Global
              </Badge>
            )}
            {!isOwnerRow && admin.role === "operator" && countryScopes.length === 0 && !inactive && (
              <Badge variant="destructive" className="text-[10px] gap-0.5">
                <Globe className="h-2.5 w-2.5" />
                No scopes
              </Badge>
            )}
          </div>
        </div>
      </div>

      {canManage && !isOwnerRow && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon"><MoreVertical className="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!inactive && onRoleChange && (
              <>
                <DropdownMenuItem onClick={() => onRoleChange("admin")}>Set as Admin</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRoleChange("operator")}>Set as Operator</DropdownMenuItem>
              </>
            )}
            {!inactive && onEditScopes && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onEditScopes}>
                  <Globe className="h-4 w-4 mr-2" /> Edit Country Scopes
                </DropdownMenuItem>
              </>
            )}
            {!inactive && onDeactivate && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={onDeactivate}>
                  <UserMinus className="h-4 w-4 mr-2" /> Deactivate
                </DropdownMenuItem>
              </>
            )}
            {inactive && onReactivate && (
              <DropdownMenuItem onClick={onReactivate}>
                <RefreshCw className="h-4 w-4 mr-2" /> Reactivate
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
