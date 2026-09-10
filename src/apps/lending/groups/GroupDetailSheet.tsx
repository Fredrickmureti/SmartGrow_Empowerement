/**
 * Group detail sheet — the read-only view of an existing group.
 *
 * Clicking a group in the list means "show me this group", never "put it into
 * an editable form". Editing the group itself is a deliberate act behind the
 * Edit action; the membership roll and admission fees keep their own separate
 * actions because they are different business events.
 */

import { Pencil, Receipt, Users } from "lucide-react";
import { DetailSheet, FooterActionBar, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { useMfClients } from "@/hooks/useMfClients";
import {
  meetingDayLabel,
  useMfGroupMembers,
  type MfGroup,
  type MfGroupStatus,
} from "@/hooks/useMfGroups";
import { Block, Field } from "../shared/detailFields";

const STATUS_TONE: Record<MfGroupStatus, "neutral" | "success" | "warning" | "danger"> = {
  forming: "warning",
  active: "success",
  dormant: "warning",
  closed: "neutral",
};

interface Props {
  group: MfGroup | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the signed-in user may change the group record. */
  canManage: boolean;
  onEdit: () => void;
  onOpenRoll: () => void;
  onOpenFees: () => void;
}

export function GroupDetailSheet({
  group,
  open,
  onOpenChange,
  canManage,
  onEdit,
  onOpenRoll,
  onOpenFees,
}: Props) {
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();
  const { clients } = useMfClients();
  // Reading the roll is what makes the sheet informative; it never writes.
  const { members } = useMfGroupMembers(open ? (group?.id ?? null) : null);

  if (!group) return null;

  const branchName = branches.find((b) => b.id === group.branch_id)?.name ?? "—";
  const clientLabel = (id: string) => {
    const c = clients.find((x) => x.id === id);
    return c ? `${c.client_number} — ${c.full_name}` : id;
  };
  const activeMembers = members.filter((m) => m.is_active);

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{group.name}</span>
          <StatusBadge tone={STATUS_TONE[group.status]}>{group.status}</StatusBadge>
        </span>
      }
      description={`Group ${group.group_number} · stored record`}
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <>
              <Button variant="outline" onClick={onOpenRoll}>
                <Users className="mr-1.5 h-4 w-4" />
                Roll
              </Button>
              <Button variant="outline" onClick={onOpenFees}>
                <Receipt className="mr-1.5 h-4 w-4" />
                Admission fees
              </Button>
            </>
          }
          trailing={
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {canManage && (
                <Button onClick={onEdit}>
                  <Pencil className="mr-1.5 h-4 w-4" />
                  Edit group
                </Button>
              )}
            </>
          }
        />
      }
    >
      <div className="space-y-6">
        <Block title="Identity">
          <Field
            label="Group number"
            value={<span className="font-mono">{group.group_number}</span>}
          />
          <Field label="Name" value={group.name} />
          <Field label="Status" value={group.status} />
          <Field label="Formed on" value={group.formed_on} />
        </Block>

        <Separator />

        <Block title="Ownership">
          <Field label="Branch" value={branchName} />
          <Field
            label="Loan officer"
            value={group.loan_officer_id ? getUserName(group.loan_officer_id) : "Unassigned"}
          />
        </Block>

        <Separator />

        <Block title="Meeting">
          <Field label="Day" value={meetingDayLabel(group.meeting_day)} />
          <Field label="Time" value={group.meeting_time?.slice(0, 5)} />
          <div className="sm:col-span-2">
            <Field label="Place" value={group.meeting_place} />
          </div>
        </Block>

        <Separator />

        <Block title="Membership">
          <Field label="Active members" value={activeMembers.length} />
          <Field label="On the roll (ever)" value={members.length} />
          <div className="sm:col-span-2">
            {activeMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active members yet. Use Roll to add clients to this group.
              </p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {activeMembers.map((m) => (
                  <li key={m.id} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{clientLabel(m.client_id)}</span>
                    <span className="text-muted-foreground">
                      {m.role_in_group} · joined {m.joined_on}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Block>

        <Separator />

        <Block title="Notes">
          <div className="sm:col-span-2">
            <Field label="Notes" value={group.notes} />
          </div>
        </Block>
      </div>
    </DetailSheet>
  );
}

export default GroupDetailSheet;
