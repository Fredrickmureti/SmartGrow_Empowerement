/**
 * Lending → Groups (C3).
 *
 * Optional group structures: owning branch and loan officer, a weekly meeting
 * slot and a membership roll. Group membership never implies a joint loan.
 */

import { useMemo, useState } from "react";
import { usePermissions } from "@/hooks/usePermissions";
import { Plus, Users } from "lucide-react";
import {
  PageHeader,
  PageBody,
  Section,
  FilterBar,
  EmptyState,
  LoadingState,
  ErrorState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import {
  MF_GROUP_STATUSES,
  meetingDayLabel,
  useMfGroups,
  type MfGroup,
  type MfGroupStatus,
} from "@/hooks/useMfGroups";
import { GroupFormDialog } from "./GroupFormDialog";
import { GroupMembersDialog } from "./GroupMembersDialog";

const STATUS_TONE: Record<MfGroupStatus, "neutral" | "success" | "warning" | "danger"> = {
  forming: "warning",
  active: "success",
  dormant: "warning",
  closed: "neutral",
};

export function GroupsPage() {
  const { can } = usePermissions();
  const canManage = can("manageClients");
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();
  const [branchId, setBranchId] = useState<string>("all");
  const [status, setStatus] = useState<MfGroupStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MfGroup | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [rollGroup, setRollGroup] = useState<MfGroup | null>(null);
  const [rollOpen, setRollOpen] = useState(false);

  const { groups, isLoading, error, createGroup, updateGroup } = useMfGroups({
    branchId: branchId === "all" ? null : branchId,
    status,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) =>
      [g.name, g.group_number, g.meeting_place]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [groups, search]);

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? "—";

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (group: MfGroup) => {
    setEditing(group);
    setFormOpen(true);
  };

  const openRoll = (group: MfGroup) => {
    setRollGroup(group);
    setRollOpen(true);
  };

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Groups"
        description="Collection groups with a weekly meeting slot and membership roll."
        actions={
          canManage ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" />
              Create group
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        <Section title="Groups" description={`${filtered.length} group(s)`}>
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            placeholder="Search name, number or meeting place…"
          >
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="h-8 w-[180px] text-sm">
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as MfGroupStatus | "all")}
            >
              <SelectTrigger className="h-8 w-[150px] text-sm">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {MF_GROUP_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBar>

          {error ? (
            <ErrorState description={error.message} />
          ) : isLoading ? (
            <LoadingState />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No groups yet"
              description="Create a group to organise weekly meetings and collections."
              action={canManage ? <Button onClick={openCreate}>Create group</Button> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Loan officer</TableHead>
                  <TableHead>Meeting</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((g) => (
                  <TableRow
                    key={g.id}
                    className={canManage ? "cursor-pointer" : undefined}
                    onClick={canManage ? () => openEdit(g) : undefined}
                  >
                    <TableCell className="font-mono text-xs">{g.group_number}</TableCell>
                    <TableCell className="font-medium">{g.name}</TableCell>
                    <TableCell>{branchName(g.branch_id)}</TableCell>
                    <TableCell>
                      {g.loan_officer_id ? getUserName(g.loan_officer_id) : "Unassigned"}
                    </TableCell>
                    <TableCell>
                      {meetingDayLabel(g.meeting_day)}
                      {g.meeting_time ? ` · ${g.meeting_time.slice(0, 5)}` : ""}
                      {g.meeting_place ? ` · ${g.meeting_place}` : ""}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={STATUS_TONE[g.status]}>{g.status}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRoll(g);
                        }}
                      >
                        <Users className="mr-1.5 h-3.5 w-3.5" />
                        Roll
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      <GroupFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        group={editing}
        existingGroups={groups}
        onCreate={async (input) => {
          await createGroup.mutateAsync(input);
        }}
        onUpdate={async (id, patch) => {
          await updateGroup.mutateAsync({ id, ...patch });
        }}
      />

      <GroupMembersDialog
        open={rollOpen}
        onOpenChange={setRollOpen}
        group={rollGroup}
      />
    </>
  );
}

export default GroupsPage;
