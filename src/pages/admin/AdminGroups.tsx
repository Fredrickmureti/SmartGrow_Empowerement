import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { usePlatformGroups, PlatformGroup } from "@/hooks/usePlatformGroups";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { usePlatformPermissionDefinitions } from "@/hooks/usePlatformPermissionDefinitions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, Users, Lock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

export default function AdminGroups() {
  const navigate = useNavigate();
  const { groups, isLoading, fetchGroups, deleteGroup } = usePlatformGroups();
  const { isOwner, hasPerm } = usePlatformPermissions();
  const { data: permDefinitions } = usePlatformPermissionDefinitions();

  useEffect(() => { fetchGroups(); }, []);

  const canManage = isOwner || hasPerm("team.manage");

  const openCreate = () => navigate("/admin-management/groups/new");
  const openEdit = (group: PlatformGroup) =>
    navigate(`/admin-management/groups/${group.id}/edit`);

  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg sm:text-xl lg:text-2xl font-bold tracking-tight">Access Groups</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">Define permission groups for platform operators</p>
          </div>
          {canManage && (
            <Button onClick={openCreate} className="w-full sm:w-auto"><Plus className="h-4 w-4 mr-2" /> Create Group</Button>
          )}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-40" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {groups.map(group => (
              <Card key={group.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base">{group.name}</CardTitle>
                      {group.is_system && <Badge variant="secondary" className="text-[10px]"><Lock className="h-3 w-3 mr-1" />System</Badge>}
                    </div>
                    {canManage && (
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {!group.is_system && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete Group</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will remove the group and unassign all members. This action cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => deleteGroup(group.id)}>Delete</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    )}
                  </div>
                  {group.description && <CardDescription className="text-xs">{group.description}</CardDescription>}
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" /> {group.member_count} members
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {group.permissions.slice(0, 6).map(p => {
                      const def = permDefinitions?.find(d => d.key === p);
                      return (
                        <Badge key={p} variant="outline" className="text-[10px]">{def?.label || p}</Badge>
                      );
                    })}
                    {group.permissions.length > 6 && (
                      <Badge variant="outline" className="text-[10px]">+{group.permissions.length - 6} more</Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

      </div>
    </>
  );
}
