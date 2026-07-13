// @ts-nocheck - Admin tables not in auto-generated types
/**
 * AdminUserPeekSheet — read-mostly peek sheet for the Users list.
 * Replaces the legacy UserDetailsDialog. Fetched via `?peek=<userId>` on
 * `/admin-management/users`, following the peek convention documented in
 * `docs/design-system/audit/platform-admin.md`.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Building2,
  Briefcase,
  MapPin,
  Calendar,
  Mail,
  ChevronRight,
  User as UserIcon,
  Shield,
} from "lucide-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { DocumentPeekShell } from "@/design-system";

export interface AdminUserPeekUser {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  isPlatformAdmin: boolean;
}

interface Business {
  id: string;
  name: string;
  email: string | null;
  is_active: boolean;
  branches: Branch[];
}
interface Branch {
  id: string;
  name: string;
  code: string | null;
  is_headquarters: boolean;
  city: string | null;
}
interface OrganizationHierarchy {
  id: string;
  name: string;
  slug: string;
  role: string;
  created_at: string;
  businesses: Business[];
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  admin: "Admin",
  accountant: "Accountant",
  staff: "Staff",
  viewer: "Viewer",
};

function roleVariant(role: string) {
  switch (role) {
    case "owner":
    case "super_admin":
      return "default" as const;
    case "admin":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: AdminUserPeekUser | null;
}

export function AdminUserPeekSheet({ open, onOpenChange, user }: Props) {
  const [organizations, setOrganizations] = useState<OrganizationHierarchy[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());
  const [expandedBusinesses, setExpandedBusinesses] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const { data: rolesData, error: rolesError } = await supabase
          .from("user_roles")
          .select(
            "role, organization_id, organizations ( id, name, slug, created_at )",
          )
          .eq("user_id", user.user_id)
          .eq("is_active", true);
        if (rolesError) throw rolesError;

        const orgIds = rolesData?.map((r: any) => r.organization_id) || [];
        let businessesData: any[] = [];
        if (orgIds.length > 0) {
          const { data } = await supabase
            .from("businesses")
            .select("*")
            .in("organization_id", orgIds)
            .eq("is_active", true)
            .order("name");
          businessesData = data || [];
        }
        const businessIds = businessesData.map((b) => b.id);
        let branchesData: any[] = [];
        if (businessIds.length > 0) {
          const { data } = await supabase
            .from("branches")
            .select("*")
            .in("business_id", businessIds)
            .eq("is_active", true)
            .order("is_headquarters", { ascending: false })
            .order("name");
          branchesData = data || [];
        }

        const hierarchy: OrganizationHierarchy[] = (rolesData || []).map(
          (r: any) => {
            const org = r.organizations;
            const orgBusinesses = businessesData.filter(
              (b) => b.organization_id === org.id,
            );
            return {
              id: org.id,
              name: org.name,
              slug: org.slug,
              role: r.role,
              created_at: org.created_at,
              businesses: orgBusinesses.map((b) => ({
                id: b.id,
                name: b.name,
                email: b.email,
                is_active: b.is_active,
                branches: branchesData
                  .filter((br) => br.business_id === b.id)
                  .map((br) => ({
                    id: br.id,
                    name: br.name,
                    code: br.code,
                    is_headquarters: br.is_headquarters,
                    city: br.city,
                  })),
              })),
            };
          },
        );
        if (!cancelled) {
          setOrganizations(hierarchy);
          setExpandedOrgs(new Set(hierarchy.map((o) => o.id)));
        }
      } catch (err: any) {
        if (!cancelled)
          setError(err?.message || "Could not load user hierarchy.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [open, user]);

  const totalBusinesses = organizations.reduce(
    (s, o) => s + o.businesses.length,
    0,
  );
  const totalBranches = organizations.reduce(
    (s, o) => s + o.businesses.reduce((bs, b) => bs + b.branches.length, 0),
    0,
  );

  const title = user ? (
    <div className="flex items-center gap-3 min-w-0">
      <Avatar className="h-10 w-10 shrink-0">
        <AvatarFallback className="bg-primary/10 text-primary text-sm">
          {user.email.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <span className="truncate">{user.full_name || user.email}</span>
          {user.isPlatformAdmin && (
            <Badge className="bg-primary/10 text-primary border-primary/20">
              <Shield className="mr-1 h-3 w-3" />
              Platform Admin
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5 truncate">
          <Mail className="h-3 w-3 shrink-0" />
          <span className="truncate">{user.email}</span>
        </p>
      </div>
    </div>
  ) : (
    "User details"
  );

  return (
    <DocumentPeekShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      loading={isLoading}
      error={error}
    >
      {user && (
        <div className="space-y-4 p-1">
          <div className="grid grid-cols-3 gap-2">
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3">
              <Building2 className="h-4 w-4 text-primary" />
              <div>
                <p className="text-xl font-bold leading-none">
                  {organizations.length}
                </p>
                <p className="text-[10px] text-muted-foreground">Organizations</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3">
              <Briefcase className="h-4 w-4 text-blue-500" />
              <div>
                <p className="text-xl font-bold leading-none">
                  {totalBusinesses}
                </p>
                <p className="text-[10px] text-muted-foreground">Businesses</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3">
              <MapPin className="h-4 w-4 text-amber-500" />
              <div>
                <p className="text-xl font-bold leading-none">{totalBranches}</p>
                <p className="text-[10px] text-muted-foreground">Branches</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" />
            <span>
              Joined {format(new Date(user.created_at), "MMMM d, yyyy")}
            </span>
          </div>

          <Separator />

          <div className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4" /> Organization Hierarchy
            </h3>
            {organizations.length === 0 ? (
              <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
                <UserIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
                This user has no organizations
              </div>
            ) : (
              <div className="space-y-2">
                {organizations.map((org) => (
                  <Collapsible
                    key={org.id}
                    open={expandedOrgs.has(org.id)}
                    onOpenChange={() => {
                      const next = new Set(expandedOrgs);
                      next.has(org.id) ? next.delete(org.id) : next.add(org.id);
                      setExpandedOrgs(next);
                    }}
                  >
                    <CollapsibleTrigger className="w-full">
                      <div className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:bg-muted/50">
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 text-muted-foreground transition-transform",
                            expandedOrgs.has(org.id) && "rotate-90",
                          )}
                        />
                        <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Building2 className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <p className="text-sm font-medium truncate">
                            {org.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {org.businesses.length} business
                            {org.businesses.length !== 1 ? "es" : ""}
                          </p>
                        </div>
                        <Badge variant={roleVariant(org.role)}>
                          {ROLE_LABELS[org.role] || org.role}
                        </Badge>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-6 mt-2 space-y-2 border-l-2 border-muted pl-4">
                        {org.businesses.length === 0 ? (
                          <p className="py-2 text-xs text-muted-foreground">
                            No businesses created
                          </p>
                        ) : (
                          org.businesses.map((business) => (
                            <Collapsible
                              key={business.id}
                              open={expandedBusinesses.has(business.id)}
                              onOpenChange={() => {
                                const next = new Set(expandedBusinesses);
                                next.has(business.id)
                                  ? next.delete(business.id)
                                  : next.add(business.id);
                                setExpandedBusinesses(next);
                              }}
                            >
                              <CollapsibleTrigger className="w-full">
                                <div className="flex items-center gap-3 rounded-lg border bg-card/50 p-2.5 hover:bg-muted/30">
                                  <ChevronRight
                                    className={cn(
                                      "h-3.5 w-3.5 text-muted-foreground transition-transform",
                                      expandedBusinesses.has(business.id) &&
                                        "rotate-90",
                                    )}
                                  />
                                  <div className="h-7 w-7 rounded-md bg-blue-500/10 flex items-center justify-center">
                                    <Briefcase className="h-3.5 w-3.5 text-blue-500" />
                                  </div>
                                  <div className="flex-1 text-left min-w-0">
                                    <p className="text-sm font-medium truncate">
                                      {business.name}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {business.branches.length} branch
                                      {business.branches.length !== 1
                                        ? "es"
                                        : ""}
                                    </p>
                                  </div>
                                </div>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <div className="ml-5 mt-1.5 space-y-1 border-l border-muted pl-3">
                                  {business.branches.length === 0 ? (
                                    <p className="py-1.5 text-xs text-muted-foreground">
                                      No branches created
                                    </p>
                                  ) : (
                                    business.branches.map((branch) => (
                                      <div
                                        key={branch.id}
                                        className="flex items-center gap-2.5 rounded-md bg-muted/30 p-2"
                                      >
                                        <div className="h-6 w-6 rounded bg-amber-500/10 flex items-center justify-center">
                                          <MapPin className="h-3 w-3 text-amber-500" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-sm font-medium flex items-center gap-2 truncate">
                                            {branch.name}
                                            {branch.is_headquarters && (
                                              <Badge
                                                variant="outline"
                                                className="text-[10px] px-1.5 py-0"
                                              >
                                                HQ
                                              </Badge>
                                            )}
                                          </p>
                                          {(branch.code || branch.city) && (
                                            <p className="text-xs text-muted-foreground truncate">
                                              {[branch.code, branch.city]
                                                .filter(Boolean)
                                                .join(" • ")}
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          ))
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </DocumentPeekShell>
  );
}
