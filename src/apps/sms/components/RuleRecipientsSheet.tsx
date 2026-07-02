import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Trash2, Plus, Loader2 } from "lucide-react";
import { useSmsRecipientGroups, useSmsRuleRecipients, type SmsRuleRecipient } from "@/hooks/useSmsRuleRecipients";
import { isValidE164, normalizeE164 } from "@/lib/sms/phone";
import { toast } from "sonner";

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "owner", label: "Owners" },
  { value: "admin", label: "Admins" },
  { value: "accountant", label: "Accountants" },
  { value: "staff", label: "Staff" },
  { value: "cashier", label: "Cashiers" },
];

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ruleId: string | null;
  eventLabel: string;
}

export function RuleRecipientsSheet({ open, onOpenChange, ruleId, eventLabel }: Props) {
  const { recipients, isLoading, addRecipient, removeRecipient, toggleFallback } = useSmsRuleRecipients(ruleId);
  const { groups, createGroup } = useSmsRecipientGroups();

  const [kind, setKind] = useState<"group" | "phone" | "role">("phone");
  const [phoneInput, setPhoneInput] = useState("");
  const [roleInput, setRoleInput] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const [newGroupName, setNewGroupName] = useState("");

  function handleAdd() {
    if (!ruleId) return;
    if (kind === "phone") {
      const norm = normalizeE164(phoneInput);
      if (!norm || !isValidE164(norm)) {
        toast.error("Phone must be in international (E.164) format, e.g. +14155552671");
        return;
      }
      addRecipient.mutate({ recipient_kind: "phone", phone: norm }, { onSuccess: () => setPhoneInput("") });
    } else if (kind === "role") {
      if (!roleInput) return;
      addRecipient.mutate({ recipient_kind: "role", role: roleInput as never }, { onSuccess: () => setRoleInput("") });
    } else if (kind === "group") {
      if (!groupInput) return;
      addRecipient.mutate({ recipient_kind: "group", group_id: groupInput }, { onSuccess: () => setGroupInput("") });
    }
  }

  function describe(r: SmsRuleRecipient): string {
    if (r.recipient_kind === "phone") return r.phone || "(no phone)";
    if (r.recipient_kind === "role") return `Role: ${r.role}`;
    if (r.recipient_kind === "group") {
      const g = groups.find((x) => x.id === r.group_id);
      return `Group: ${g?.name ?? r.group_id}`;
    }
    if (r.recipient_kind === "user") return `User: ${r.user_id}`;
    return r.recipient_kind;
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Recipients · {eventLabel}</SheetTitle>
          <SheetDescription>
            The default recipient (customer / vendor / employee / internal) is always tried first.
            Add additional recipients below — groups, roles, or specific phone numbers.
            Mark a recipient as fallback to only fire when no primary recipient resolves.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 mt-4">
          {/* Add new recipient */}
          <div className="border rounded p-3 space-y-3">
            <Label className="text-xs uppercase tracking-wider">Add recipient</Label>
            <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_auto] gap-2 items-end">
              <div>
                <Label className="text-xs">Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="phone">Phone</SelectItem>
                    <SelectItem value="role">Role</SelectItem>
                    <SelectItem value="group">Group</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                {kind === "phone" && (
                  <>
                    <Label className="text-xs">Phone (E.164)</Label>
                    <Input value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} placeholder="+14155552671" />
                  </>
                )}
                {kind === "role" && (
                  <>
                    <Label className="text-xs">Role</Label>
                    <Select value={roleInput} onValueChange={setRoleInput}>
                      <SelectTrigger><SelectValue placeholder="Pick a role" /></SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
                {kind === "group" && (
                  <>
                    <Label className="text-xs">Group</Label>
                    <Select value={groupInput} onValueChange={setGroupInput}>
                      <SelectTrigger><SelectValue placeholder="Pick a group" /></SelectTrigger>
                      <SelectContent>
                        {groups.length === 0 && (
                          <p className="px-2 py-1.5 text-sm text-muted-foreground">No groups yet — create one below.</p>
                        )}
                        {groups.map((g) => (
                          <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
              <Button size="sm" onClick={handleAdd} disabled={addRecipient.isPending || !ruleId}>
                {addRecipient.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>

            {kind === "group" && (
              <div className="border-t pt-3">
                <Label className="text-xs">Or create a new group</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="e.g. Inventory Managers" />
                  <Button size="sm" variant="outline" disabled={!newGroupName.trim()}
                    onClick={() => createGroup.mutate(newGroupName.trim(), { onSuccess: () => setNewGroupName("") })}>
                    Create
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Group members can be managed in Settings → SMS → Groups (coming soon).</p>
              </div>
            )}
          </div>

          {/* Existing recipients */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider">Configured recipients</Label>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : recipients.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No additional recipients configured. The rule will only send to the default recipient (per the rule's recipient type).
              </p>
            ) : (
              <ul className="divide-y border rounded">
                {recipients.map((r) => (
                  <li key={r.id} className="px-3 py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{describe(r)}</div>
                      <div className="text-xs text-muted-foreground capitalize">{r.recipient_kind}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">Fallback</Label>
                      <Switch
                        checked={r.is_fallback}
                        onCheckedChange={(v) => toggleFallback.mutate({ id: r.id, is_fallback: v })}
                      />
                      <Button size="icon" variant="ghost" onClick={() => removeRecipient.mutate(r.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}