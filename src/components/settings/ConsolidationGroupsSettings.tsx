/**
 * Consolidation group configuration (Settings → Workspace → Consolidation).
 *
 * Phase 3 of the consolidation roadmap: the *configuration* surface for group
 * reporting — parent/subsidiary hierarchy, ownership percentages and the
 * consolidation method per entity, plus the group's presentation currency.
 *
 * This screen produces no financial figures. Statements continue to come from
 * the authoritative SQL reporting engine; FX translation (Phase 4) and
 * eliminations (Phase 6) build on the structure defined here.
 */
import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { GitMerge, Info, Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrencies } from "@/hooks/useCurrencies";
import {
  CONSOLIDATION_METHOD_LABELS,
  useConsolidationGroupMembers,
  useConsolidationGroupMutations,
  useConsolidationGroups,
  type ConsolidationMethod,
} from "@/hooks/finance/useConsolidationGroups";
import { normalizeError } from "@/services/resilience";

const METHODS = Object.keys(CONSOLIDATION_METHOD_LABELS) as ConsolidationMethod[];

export function ConsolidationGroupsSettings() {
  const { toast } = useToast();
  const { businesses } = useBusinesses();
  const { currencies } = useCurrencies();
  const { data: groups = [], isLoading } = useConsolidationGroups();
  const { createGroup, deleteGroup, addMember, updateMember, removeMember } =
    useConsolidationGroupMutations();

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const activeGroupId = selectedGroupId ?? groups[0]?.id ?? null;
  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;
  const { data: members = [] } = useConsolidationGroupMembers(activeGroupId);

  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [newCurrency, setNewCurrency] = useState("");

  const [memberBusiness, setMemberBusiness] = useState("");
  const [memberParent, setMemberParent] = useState("");
  const [memberOwnership, setMemberOwnership] = useState("100");
  const [memberMethod, setMemberMethod] = useState<ConsolidationMethod>("full");

  const businessName = (id: string | null) =>
    businesses.find((b) => b.id === id)?.name ?? "—";

  const availableBusinesses = useMemo(
    () => businesses.filter((b) => !members.some((m) => m.business_id === b.id)),
    [businesses, members],
  );

  const fail = (error: unknown, fallback: string) =>
    toast({
      title: fallback,
      description: normalizeError(error).message,
      variant: "destructive",
    });

  const handleCreateGroup = async () => {
    if (!newName.trim() || !newParent || !newCurrency) return;
    try {
      const id = await createGroup.mutateAsync({
        name: newName.trim(),
        parent_business_id: newParent,
        presentation_currency: newCurrency,
      });
      setSelectedGroupId(id);
      setNewName("");
      setNewParent("");
      setNewCurrency("");
      toast({ title: "Consolidation group created" });
    } catch (error) {
      fail(error, "Could not create the group");
    }
  };

  const handleAddMember = async () => {
    if (!activeGroupId || !memberBusiness) return;
    try {
      await addMember.mutateAsync({
        group_id: activeGroupId,
        business_id: memberBusiness,
        parent_business_id: memberParent || activeGroup?.parent_business_id || null,
        ownership_percent: Number(memberOwnership) || 0,
        method: memberMethod,
        effective_from: new Date().toISOString().slice(0, 10),
      });
      setMemberBusiness("");
      setMemberParent("");
      setMemberOwnership("100");
      setMemberMethod("full");
      toast({ title: "Company added to the group" });
    } catch (error) {
      fail(error, "Could not add the company");
    }
  };

  return (
    <div className="space-y-6">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          Defining a group records the ownership structure only. It does not
          change any company's books, and no consolidated statement is produced
          yet — currency translation and intercompany eliminations are separate,
          later steps.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <GitMerge className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>Consolidation groups</CardTitle>
              <CardDescription>
                A group is a parent company plus the entities reported with it,
                expressed in one reporting currency.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading groups…
            </div>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No consolidation group defined yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <Button
                  key={group.id}
                  variant={group.id === activeGroupId ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedGroupId(group.id)}
                  className="gap-2"
                >
                  {group.name}
                  <Badge variant="secondary">{group.presentation_currency}</Badge>
                </Button>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-4 border-t pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">Group name</Label>
              <Input
                id="group-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Acme Group"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Parent company</Label>
              <Select value={newParent} onValueChange={setNewParent}>
                <SelectTrigger>
                  <SelectValue placeholder="Select company" />
                </SelectTrigger>
                <SelectContent>
                  {businesses.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Reporting currency</Label>
              <Select value={newCurrency} onValueChange={setNewCurrency}>
                <SelectTrigger>
                  <SelectValue placeholder="Select currency" />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                onClick={handleCreateGroup}
                disabled={
                  !newName.trim() ||
                  !newParent ||
                  !newCurrency ||
                  createGroup.isPending
                }
                className="gap-2 w-full"
              >
                {createGroup.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create group
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {activeGroup && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{activeGroup.name} — entities</CardTitle>
                <CardDescription>
                  Parent: {businessName(activeGroup.parent_business_id)} · reported
                  in {activeGroup.presentation_currency}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={async () => {
                  try {
                    await deleteGroup.mutateAsync(activeGroup.id);
                    setSelectedGroupId(null);
                    toast({ title: "Group removed" });
                  } catch (error) {
                    fail(error, "Could not remove the group");
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete group
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Owned by</TableHead>
                    <TableHead className="text-right">Ownership</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Effective from</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell className="font-medium">
                        {businessName(member.business_id)}
                      </TableCell>
                      <TableCell>
                        {member.parent_business_id
                          ? businessName(member.parent_business_id)
                          : "Top of group"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Number(member.ownership_percent).toFixed(2)}%
                      </TableCell>
                      <TableCell>
                        <Select
                          value={member.method}
                          onValueChange={async (value) => {
                            try {
                              await updateMember.mutateAsync({
                                id: member.id,
                                method: value as ConsolidationMethod,
                              });
                            } catch (error) {
                              fail(error, "Could not update the method");
                            }
                          }}
                        >
                          <SelectTrigger className="h-8 w-[240px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {METHODS.map((m) => (
                              <SelectItem key={m} value={m}>
                                {CONSOLIDATION_METHOD_LABELS[m]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>{member.effective_from}</TableCell>
                      <TableCell>
                        {member.business_id !== activeGroup.parent_business_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={async () => {
                              try {
                                await removeMember.mutateAsync(member.id);
                              } catch (error) {
                                fail(error, "Could not remove the company");
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {members.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground">
                        No entities in this group yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="grid gap-3 sm:grid-cols-5 border-t pt-4">
              <div className="space-y-1.5">
                <Label>Company</Label>
                <Select value={memberBusiness} onValueChange={setMemberBusiness}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBusinesses.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Owned by</Label>
                <Select value={memberParent} onValueChange={setMemberParent}>
                  <SelectTrigger>
                    <SelectValue placeholder="Parent company" />
                  </SelectTrigger>
                  <SelectContent>
                    {members
                      .filter((m) => m.business_id !== memberBusiness)
                      .map((m) => (
                        <SelectItem key={m.business_id} value={m.business_id}>
                          {businessName(m.business_id)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ownership">Ownership %</Label>
                <Input
                  id="ownership"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={memberOwnership}
                  onChange={(e) => setMemberOwnership(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Method</Label>
                <Select
                  value={memberMethod}
                  onValueChange={(v) => setMemberMethod(v as ConsolidationMethod)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METHODS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {CONSOLIDATION_METHOD_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button
                  onClick={handleAddMember}
                  disabled={!memberBusiness || addMember.isPending}
                  className="gap-2 w-full"
                >
                  {addMember.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Add company
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
