/**
 * AdminTeamInvitePage — workspace at `/admin-management/team/invite`
 * for inviting a platform administrator or operator. Replaces the
 * legacy inline `<Dialog>` previously mounted from
 * `src/pages/admin/AdminTeam.tsx`, per the Platform Admin four-pattern
 * rule in `docs/design-system/audit/platform-admin.md`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "@/design-system";
import { AdminRecordForm, AdminFieldGrid, AdminFieldCell } from "@/apps/platform-admin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePlatformTeam } from "@/hooks/usePlatformTeam";
import { usePlatformGroups } from "@/hooks/usePlatformGroups";
import { useCountries } from "@/hooks/useCountries";
import { useToast } from "@/hooks/use-toast";

const LIST_PATH = "/admin-management/team";

export default function AdminTeamInvitePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { inviteAdmin } = usePlatformTeam();
  const { groups, fetchGroups } = usePlatformGroups();
  const { countries } = useCountries();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "operator">("operator");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email.trim()) {
      toast({ title: "Email is required", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      await inviteAdmin(email.trim(), role, selectedGroups, selectedCountries);
      navigate(LIST_PATH);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleGroup = (id: string, checked: boolean) =>
    setSelectedGroups((prev) =>
      checked ? [...prev, id] : prev.filter((g) => g !== id),
    );

  const toggleCountry = (code: string, checked: boolean) =>
    setSelectedCountries((prev) =>
      checked ? [...prev, code] : prev.filter((c) => c !== code),
    );

  return (
    <AdminRecordForm
      mode="create"
      entityLabel="Team member"
      meta="Invite a new platform administrator or operator. They receive an email with an activation link."
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Send invitation"
    >
      <Section title="Identity" description="Who are we inviting and at what level of access.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email address *</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="team@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v: "admin" | "operator") => setRole(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin — Can manage groups and invite operators</SelectItem>
                <SelectItem value="operator">Operator — Scoped access via groups</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </AdminFieldGrid>
      </Section>

      <Section title="Groups" description="Access groups this member inherits permissions from.">
        <AdminFieldCell span={2}>
          <div className="space-y-2 max-h-64 overflow-y-auto border rounded-md p-3">
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No groups defined yet.</p>
            ) : (
              groups.map((g) => (
                <label
                  key={g.id}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedGroups.includes(g.id)}
                    onCheckedChange={(c) => toggleGroup(g.id, Boolean(c))}
                  />
                  <span className="text-sm">{g.name}</span>
                  {g.is_system && (
                    <Badge variant="outline" className="text-[10px]">System</Badge>
                  )}
                </label>
              ))
            )}
          </div>
        </AdminFieldCell>
      </Section>

      {role === "operator" && (
        <Section
          title="Country scopes"
          description="Restrict this operator to specific countries. Leave empty to grant no access until scopes are assigned."
        >
          <AdminFieldCell span={2}>
            <div className="space-y-2 max-h-64 overflow-y-auto border rounded-md p-3">
              {countries.map((c) => (
                <label
                  key={c.code}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedCountries.includes(c.code)}
                    onCheckedChange={(v) => toggleCountry(c.code, Boolean(v))}
                  />
                  <span className="text-sm">{c.name}</span>
                </label>
              ))}
            </div>
          </AdminFieldCell>
        </Section>
      )}
    </AdminRecordForm>
  );
}