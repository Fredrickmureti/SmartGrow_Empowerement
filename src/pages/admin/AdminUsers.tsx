import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Users,
  Search,
  MoreHorizontal,
  Eye,
  Loader2,
  RefreshCw,
  Building2,
  Shield,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";
import { UserDetailsDialog } from "@/components/admin/UserDetailsDialog";
import { DeleteUserDialog } from "@/components/admin/DeleteUserDialog";

interface UserWithOrgs {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  organizations: Array<{
    id: string;
    name: string;
    role: string;
  }>;
  isPlatformAdmin: boolean;
}

export default function AdminUsers() {
  const [users, setUsers] = useState<UserWithOrgs[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserWithOrgs | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<UserWithOrgs | null>(null);

  const handleViewDetails = (user: UserWithOrgs) => {
    setSelectedUser(user);
    setDetailsDialogOpen(true);
  };
  const handleDeleteUser = (user: UserWithOrgs) => {
    setUserToDelete(user);
    setDeleteDialogOpen(true);
  };
  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      // Fetch all profiles
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false });

      if (profilesError) throw profilesError;

      // Fetch all user roles with org names
      const { data: roles } = await supabase
        .from("user_roles")
        .select(`
          user_id,
          role,
          organization_id,
          organizations (
            id,
            name
          )
        `)
        .eq("is_active", true);

      // Fetch platform admins
      const { data: platformAdmins } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("is_active", true);

      const adminUserIds = new Set(platformAdmins?.map((a) => a.user_id) || []);

      // Combine data
      const usersWithOrgs = profiles?.map((profile) => {
        const userRoles = roles?.filter((r) => r.user_id === profile.user_id) || [];
        const organizations = userRoles.map((r: any) => ({
          id: r.organizations?.id,
          name: r.organizations?.name,
          role: r.role,
        }));

        return {
          ...profile,
          organizations,
          isPlatformAdmin: adminUserIds.has(profile.user_id),
        };
      }) || [];

      setUsers(usersWithOrgs);
    } catch (error) {
      console.error("Error fetching users:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const filteredUsers = users.filter(
    (user) =>
      user.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.full_name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "owner":
        return "default";
      case "admin":
        return "secondary";
      default:
        return "outline";
    }
  };

  return (
    <>
       <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Users</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Manage all users across the platform
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchUsers} disabled={isLoading} className="self-start sm:self-auto">
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-3 sm:gap-4 grid-cols-3">
          <Card>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-sm">
                <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                <span className="truncate">Total Users</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <div className="text-lg sm:text-2xl font-bold">{users.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-sm">
                <Shield className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                <span className="truncate">Platform Admins</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <div className="text-lg sm:text-2xl font-bold">
                {users.filter((u) => u.isPlatformAdmin).length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-sm">
                <Building2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                <span className="truncate">Active in Orgs</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <div className="text-lg sm:text-2xl font-bold">
                {users.filter((u) => u.organizations.length > 0).length}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search & Table */}
        <Card>
          <CardHeader className="p-3 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
              <CardTitle className="text-sm sm:text-base">All Users</CardTitle>
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 text-sm"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0 sm:p-6 sm:pt-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Desktop Table */}
                <div className="hidden md:block rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead>User</TableHead>
                        <TableHead>Organizations</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Joined</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredUsers.length > 0 ? (
                        filteredUsers.map((user) => (
                          <TableRow key={user.id}>
                            <TableCell>
                              <div className="flex items-center gap-3">
                                <Avatar className="h-9 w-9 shrink-0">
                                  <AvatarFallback className="bg-secondary text-sm">
                                    {user.email.slice(0, 2).toUpperCase()}
                                  </AvatarFallback>
                                </Avatar>
                                <div className="min-w-0">
                                  <div className="font-medium truncate">
                                    {user.full_name || "—"}
                                  </div>
                                  <div className="text-sm text-muted-foreground truncate">
                                    {user.email}
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              {user.organizations.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {user.organizations.slice(0, 2).map((org) => (
                                    <Badge
                                      key={org.id}
                                      variant={getRoleBadgeVariant(org.role)}
                                      className="text-xs"
                                    >
                                      {org.name} ({org.role})
                                    </Badge>
                                  ))}
                                  {user.organizations.length > 2 && (
                                    <Badge variant="outline" className="text-xs">
                                      +{user.organizations.length - 2} more
                                    </Badge>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground text-sm">
                                  No organizations
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              {user.isPlatformAdmin ? (
                                <Badge className="bg-primary/10 text-primary border-primary/20">
                                  <Shield className="mr-1 h-3 w-3" />
                                  Admin
                                </Badge>
                              ) : (
                                <Badge variant="outline">User</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                              {format(new Date(user.created_at), "MMM d, yyyy")}
                            </TableCell>
                            <TableCell>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-8 w-8">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => handleViewDetails(user)}>
                                    <Eye className="mr-2 h-4 w-4" />
                                    View Details
                                  </DropdownMenuItem>
                                  {!user.isPlatformAdmin && (
                                    <DropdownMenuItem
                                      onClick={() => handleDeleteUser(user)}
                                      className="text-destructive focus:text-destructive"
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      Delete user
                                    </DropdownMenuItem>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground py-12">
                            <Users className="h-12 w-12 mx-auto mb-3 opacity-20" />
                            <p>No users found</p>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile Card List */}
                <div className="md:hidden divide-y divide-border">
                  {filteredUsers.length > 0 ? (
                    filteredUsers.map((user) => (
                      <div key={user.id} className="flex items-start gap-3 p-3" onClick={() => handleViewDetails(user)}>
                        <Avatar className="h-9 w-9 shrink-0 mt-0.5">
                          <AvatarFallback className="bg-secondary text-xs">
                            {user.email.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium truncate">{user.full_name || "—"}</p>
                            {user.isPlatformAdmin ? (
                              <Badge className="bg-primary/10 text-primary border-primary/20 text-[10px] shrink-0">
                                Admin
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] shrink-0">User</Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                          <div className="flex flex-wrap items-center gap-1">
                            {user.organizations.length > 0 ? (
                              <>
                                {user.organizations.slice(0, 1).map((org) => (
                                  <Badge
                                    key={org.id}
                                    variant={getRoleBadgeVariant(org.role)}
                                    className="text-[10px] max-w-[180px] truncate"
                                  >
                                    {org.name} ({org.role})
                                  </Badge>
                                ))}
                                {user.organizations.length > 1 && (
                                  <Badge variant="outline" className="text-[10px]">
                                    +{user.organizations.length - 1} more
                                  </Badge>
                                )}
                              </>
                            ) : (
                              <span className="text-[10px] text-muted-foreground">No organizations</span>
                            )}
                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                              {format(new Date(user.created_at), "MMM d, yyyy")}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center text-muted-foreground py-12">
                      <Users className="h-12 w-12 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No users found</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* User Details Dialog */}
      <UserDetailsDialog
        open={detailsDialogOpen}
        onOpenChange={setDetailsDialogOpen}
        user={selectedUser}
      />

      {/* Delete User Dialog */}
      <DeleteUserDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        user={userToDelete}
        onDeleted={fetchUsers}
      />
    </>
  );
}
