import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useSmsRecipientGroups } from "@/hooks/useSmsRuleRecipients";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Trash2,
  Users,
  Phone as PhoneIcon,
  Shield,
  User as UserIcon,
  Info,
} from "lucide-react";
import { normalizeE164 } from "@/lib/sms/phone";
import type { Database } from "@/integrations/supabase/types";
import { normalizeError } from "@/services/resilience";

type AppRole = Database["public"]["Enums"]["app_role"];
type MemberKind = "user" | "role" | "phone";

interface GroupMember {
  id: string;
  group_id: string;
  member_kind: MemberKind;
  user_id: string | null;
  role: AppRole | null;
  phone: string | null;
  label: string | null;
  created_at: string;
}

interface OrgUser {
  id: string;
  email: string | null;
  full_name: string | null;
}

const ROLES: AppRole[] = [
  "owner",
  "admin",
  "manager",
  "accountant",
  "sales",
  "inventory",
  "hr",
  "user",
] as AppRole[];

export default function SmsRecipientGroupsPage() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;
  const qc = useQueryClient();
  const { groups, isLoading: groupsLoading, createGroup } = useSmsRecipientGroups();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [memberKind, setMemberKind] = useState<MemberKind>("user");
  const [newUserId, setNewUserId] = useState<string>("");
  const [newRole, setNewRole] = useState<AppRole | "">("");
  const [newPhone, setNewPhone] = useState("");
  const [newLabel, setNewLabel] = useState("");

  // Org users for "user" member kind
  const { data: orgUsers = [] } = useQuery({
    queryKey: ["org-users-for-sms-groups", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id, profiles!inner(id, email, full_name)")
        .eq("organization_id", orgId!)
        .eq("is_active", true);
      if (error) throw error;
      return (
        (data || []).map((r: any) => ({
          id: r.profiles.id,
          email: r.profiles.email,
          full_name: r.profiles.full_name,
        })) as OrgUser[]
      );
    },
  });

  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ["sms-group-members", selectedGroupId],
    enabled: !!selectedGroupId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_recipient_group_members")
        .select("*")
        .eq("group_id", selectedGroupId!)
        .order("created_at");
      if (error) throw error;
      return (data || []) as GroupMember[];
    },
  });

  const addMember = useMutation({
    mutationFn: async () => {
      if (!selectedGroupId) throw new Error("Pick a group first");
      const payload: Partial<GroupMember> & { group_id: string } = {
        group_id: selectedGroupId,
        member_kind: memberKind,
        label: newLabel || null,
        user_id: null,
        role: null,
        phone: null,
      };
      if (memberKind === "user") {
        if (!newUserId) throw new Error("Select a user");
        payload.user_id = newUserId;
      } else if (memberKind === "role") {
        if (!newRole) throw new Error("Select a role");
        payload.role = newRole as AppRole;
      } else if (memberKind === "phone") {
        const normalized = normalizeE164(newPhone);
        if (!normalized)
          throw new Error("Phone must be a valid E.164 number (e.g. +14155552671)");
        payload.phone = normalized;
      }
      const { error } = await supabase
        .from("sms_recipient_group_members")
        .insert(payload as any);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sms-group-members", selectedGroupId] });
      setNewUserId("");
      setNewRole("");
      setNewPhone("");
      setNewLabel("");
      toast.success("Member added");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const removeMember = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("sms_recipient_group_members")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sms-group-members", selectedGroupId] });
      toast.success("Member removed");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const deleteGroup = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("sms_recipient_groups")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sms-recipient-groups", orgId] });
      setSelectedGroupId(null);
      toast.success("Group deleted");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  if (!orgId) {
    return (
      <div className="p-6">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>Select an organization to manage SMS recipient groups.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Users className="h-6 w-6" /> SMS Recipient Groups
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Reusable recipient lists for automated SMS event rules. Mix users, roles, and external phone numbers.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Groups list */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Groups</CardTitle>
            <CardDescription>Create and pick a group to manage its members.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder="New group name…"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!newGroupName.trim() || createGroup.isPending}
                onClick={() => {
                  createGroup.mutate(newGroupName.trim(), {
                    onSuccess: () => setNewGroupName(""),
                  });
                }}
              >
                {createGroup.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </Button>
            </div>

            {groupsLoading ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No groups yet.</p>
            ) : (
              <ul className="space-y-1">
                {groups.map((g) => (
                  <li
                    key={g.id}
                    className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md cursor-pointer ${
                      selectedGroupId === g.id
                        ? "bg-accent"
                        : "hover:bg-muted"
                    }`}
                    onClick={() => setSelectedGroupId(g.id)}
                  >
                    <span className="text-sm truncate">{g.name}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete group "${g.name}"? Its members will be removed.`)) {
                          deleteGroup.mutate(g.id);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Members of selected group */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selectedGroupId
                ? `Members of "${groups.find((g) => g.id === selectedGroupId)?.name ?? ""}"`
                : "Pick a group"}
            </CardTitle>
            <CardDescription>
              Members are resolved at send time. Roles fan out to every active user with that role.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!selectedGroupId ? (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>Select a group from the left to manage its members.</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_1fr_auto] gap-2 items-end">
                  <div>
                    <Label className="text-xs">Type</Label>
                    <Select value={memberKind} onValueChange={(v) => setMemberKind(v as MemberKind)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">User</SelectItem>
                        <SelectItem value="role">Role</SelectItem>
                        <SelectItem value="phone">Phone</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {memberKind === "user" && (
                    <div>
                      <Label className="text-xs">User</Label>
                      <Select value={newUserId} onValueChange={setNewUserId}>
                        <SelectTrigger><SelectValue placeholder="Pick a user" /></SelectTrigger>
                        <SelectContent>
                          {orgUsers.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.full_name || u.email || u.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {memberKind === "role" && (
                    <div>
                      <Label className="text-xs">Role</Label>
                      <Select value={newRole} onValueChange={(v) => setNewRole(v as AppRole)}>
                        <SelectTrigger><SelectValue placeholder="Pick a role" /></SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {memberKind === "phone" && (
                    <div>
                      <Label className="text-xs">Phone (E.164)</Label>
                      <Input
                        placeholder="+14155552671"
                        value={newPhone}
                        onChange={(e) => setNewPhone(e.target.value)}
                      />
                    </div>
                  )}

                  <div>
                    <Label className="text-xs">Label (optional)</Label>
                    <Input
                      placeholder="Notes for this member"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                    />
                  </div>

                  <Button
                    onClick={() => addMember.mutate()}
                    disabled={addMember.isPending}
                  >
                    {addMember.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    <span className="ml-1">Add</span>
                  </Button>
                </div>

                {membersLoading ? (
                  <div className="flex items-center justify-center p-4">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No members yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Member</TableHead>
                        <TableHead>Label</TableHead>
                        <TableHead className="w-12" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>
                            <Badge variant="outline" className="gap-1">
                              {m.member_kind === "user" && <UserIcon className="h-3 w-3" />}
                              {m.member_kind === "role" && <Shield className="h-3 w-3" />}
                              {m.member_kind === "phone" && <PhoneIcon className="h-3 w-3" />}
                              {m.member_kind}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {m.member_kind === "user"
                              ? orgUsers.find((u) => u.id === m.user_id)?.full_name ??
                                orgUsers.find((u) => u.id === m.user_id)?.email ??
                                m.user_id ??
                                "—"
                              : m.member_kind === "role"
                              ? m.role
                              : m.phone}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {m.label || "—"}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => removeMember.mutate(m.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
