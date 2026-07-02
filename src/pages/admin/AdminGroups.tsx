import { useEffect, useState } from "react";
import { usePlatformGroups, PlatformGroup } from "@/hooks/usePlatformGroups";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { usePlatformPermissionDefinitions, groupByCategory } from "@/hooks/usePlatformPermissionDefinitions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, Trash2, Users, Lock, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

export default function AdminGroups() {
  const { groups, isLoading, fetchGroups, createGroup, updateGroup, deleteGroup } = usePlatformGroups();
  const { isOwner, hasPerm } = usePlatformPermissions();
  const { data: permDefinitions, isLoading: defsLoading } = usePlatformPermissionDefinitions();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<PlatformGroup | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);

  useEffect(() => { fetchGroups(); }, []);

  const canManage = isOwner || hasPerm("team.manage");

  // Build categories from DB definitions
  const categories = permDefinitions ? groupByCategory(permDefinitions) : {};

  const openCreate = () => {
    setEditingGroup(null);
    setName("");
    setDescription("");
    setSelectedPerms([]);
    setDialogOpen(true);
  };

  const openEdit = (group: PlatformGroup) => {
    setEditingGroup(group);
    setName(group.name);
    setDescription(group.description || "");
    setSelectedPerms(group.permissions);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    if (editingGroup) {
      await updateGroup(editingGroup.id, name, description, selectedPerms);
    } else {
      await createGroup(name, description, selectedPerms);
    }
    setDialogOpen(false);
  };

  const togglePerm = (key: string) => {
    setSelectedPerms(prev =>
      prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]
    );
  };

  const toggleCategory = (keys: string[]) => {
    const allSelected = keys.every(k => selectedPerms.includes(k));
    if (allSelected) {
      setSelectedPerms(prev => prev.filter(p => !keys.includes(p)));
    } else {
      setSelectedPerms(prev => [...new Set([...prev, ...keys])]);
    }
  };

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

        {/* Create/Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingGroup ? "Edit Group" : "Create Group"}</DialogTitle>
              <DialogDescription>
                {editingGroup ? "Update group name, description, and permissions" : "Define a new access group with specific permissions"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Marketing Team" />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What this group has access to..." rows={2} />
              </div>
              <div className="space-y-3">
                <Label>Permissions</Label>
                {defsLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading permissions...
                  </div>
                ) : (
                  Object.entries(categories).map(([category, defs]) => {
                    const keys = defs.map(d => d.key);
                    const allSelected = keys.every(k => selectedPerms.includes(k));
                    const someSelected = keys.some(k => selectedPerms.includes(k));
                    return (
                      <div key={category} className="border rounded-md p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={allSelected}
                            ref={el => { if (el && someSelected && !allSelected) (el as any).indeterminate = true; }}
                            onCheckedChange={() => toggleCategory(keys)}
                          />
                          <span className="text-sm font-medium">{category}</span>
                        </div>
                        <div className="ml-6 grid grid-cols-1 gap-1.5">
                          {defs.map(def => (
                            <div key={def.key} className="flex items-center gap-2">
                              <Checkbox
                                checked={selectedPerms.includes(def.key)}
                                onCheckedChange={() => togglePerm(def.key)}
                              />
                              <div>
                                <span className="text-xs">{def.label}</span>
                                {def.description && (
                                  <span className="text-[10px] text-muted-foreground ml-1">— {def.description}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name.trim()}>
                {editingGroup ? "Save Changes" : "Create Group"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
