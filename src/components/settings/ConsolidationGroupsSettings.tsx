/**
 * Consolidation group configuration (Finance → Settings → Consolidation).
 *
 * Brick 1 of the consolidation roadmap: the *configuration* surface for group
 * reporting — parent/subsidiary hierarchy, ownership percentages and the
 * consolidation method per entity, plus the group's presentation currency.
 *
 * This screen produces no financial figures. Statements continue to come from
 * the authoritative SQL reporting engine; FX translation and eliminations are
 * later bricks that build on the structure defined here.
 *
 * Two invariants this screen must respect:
 * - Company pickers come from `get_user_allowed_businesses`, so a group can
 *   never be declared over a company the caller cannot access.
 * - Membership is effective-dated history: a company is closed out with an end
 *   date, never deleted, so past periods stay reproducible.
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
import {
  CalendarOff,
  Coins,
  GitMerge,
  History,
  Info,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBusinessCurrenciesFor } from "@/hooks/useBusinessCurrencies";
import {
  CONSOLIDATION_METHOD_LABELS,
  useCanManageConsolidation,
  useConsolidationAllowedBusinessIds,
  useConsolidationChangeLog,
  useConsolidationCtaAccountOptions,
  useConsolidationGroupMembers,
  useConsolidationGroupMutations,
  useConsolidationGroups,
  type ConsolidationMethod,
} from "@/hooks/finance/useConsolidationGroups";
import { normalizeError } from "@/services/resilience";
import { ConsolidationAccountMapping } from "@/components/settings/ConsolidationAccountMapping";



const METHODS = Object.keys(CONSOLIDATION_METHOD_LABELS) as ConsolidationMethod[];

const today = () => new Date().toISOString().slice(0, 10);

export function ConsolidationGroupsSettings() {
  const { toast } = useToast();
  const { businesses } = useBusinesses();
  const canManage = useCanManageConsolidation();
  const { data: allowedIds } = useConsolidationAllowedBusinessIds();
  const { data: groups = [], isLoading } = useConsolidationGroups();
  const {
    createGroup,
    deleteGroup,
    addMember,
    updateMember,
    closeMember,
    updateGroupTranslationSettings,
  } = useConsolidationGroupMutations();

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const activeGroupId = selectedGroupId ?? groups[0]?.id ?? null;
  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;
  const { data: members = [] } = useConsolidationGroupMembers(activeGroupId);
  const { data: changeLog = [] } = useConsolidationChangeLog(activeGroupId);
  const { data: ctaAccounts = [] } = useConsolidationCtaAccountOptions(
    activeGroup?.parent_business_id ?? null,
  );


  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [newCurrency, setNewCurrency] = useState("");

  const [memberBusiness, setMemberBusiness] = useState("");
  const [memberParent, setMemberParent] = useState("");
  const [memberOwnership, setMemberOwnership] = useState("100");
  const [memberMethod, setMemberMethod] = useState<ConsolidationMethod>("full");
  const [memberFrom, setMemberFrom] = useState(today);

  /** Only companies the caller can actually read may be named in a group. */
  const scopedBusinesses = useMemo(
    () => (allowedIds ? businesses.filter((b) => allowedIds.includes(b.id)) : []),
    [businesses, allowedIds],
  );

  // The presentation currency is a reporting currency of the parent company, so
  // it must be one the parent operates in — the same rule the DB guard enforces.
  const { currencies: parentCurrencies } = useBusinessCurrenciesFor(newParent || null);

  const businessName = (id: string | null) =>
    businesses.find((b) => b.id === id)?.name ?? "—";

  const openMembers = useMemo(
    () => members.filter((m) => !m.effective_to),
    [members],
  );

  const businessCurrency = (id: string | null) =>
    businesses.find((b) => b.id === id)?.base_currency ?? null;

  /**
   * Companies whose own books are kept in a currency other than the group's
   * reporting currency. Only these need translating — and only their presence
   * makes a translation reserve account mandatory.
   */
  const foreignMembers = useMemo(
    () =>
      activeGroup
        ? openMembers.filter((m) => {
            const currency = businessCurrency(m.business_id);
            return !!currency && currency !== activeGroup.presentation_currency;
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openMembers, activeGroup, businesses],
  );


  const availableBusinesses = useMemo(
    () =>
      scopedBusinesses.filter((b) => !openMembers.some((m) => m.business_id === b.id)),
    [scopedBusinesses, openMembers],
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
        parent_business_id: memberParent || null,
        ownership_percent: Number(memberOwnership),
        method: memberMethod,
        effective_from: memberFrom,
      });
      setMemberBusiness("");
      setMemberParent("");
      setMemberOwnership("100");
      setMemberMethod("full");
      setMemberFrom(today());
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
          Defining a group records the ownership structure and the currency
          rules used to report it. It never changes any company's own books —
          consolidated figures are produced at report time from each company's
          posted ledger.
        </AlertDescription>
      </Alert>


      {!canManage && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            You can review the group structure. Only workspace owners and admins
            can change it.
          </AlertDescription>
        </Alert>
      )}

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

          {canManage && (
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
                <Select
                  value={newParent}
                  onValueChange={(value) => {
                    setNewParent(value);
                    setNewCurrency("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    {scopedBusinesses.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Reporting currency</Label>
                <Select
                  value={newCurrency}
                  onValueChange={setNewCurrency}
                  disabled={!newParent}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        newParent ? "Select currency" : "Select a parent first"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {parentCurrencies.map((c) => (
                      <SelectItem key={c.currency_code} value={c.currency_code}>
                        {c.currency_code}
                        {c.is_base ? " — base currency" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {newParent && parentCurrencies.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    This company has no enabled operating currency yet.
                  </p>
                )}
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
          )}
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
              {canManage && (
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
              )}
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
                    <TableHead>Opening equity rate date</TableHead>
                    <TableHead>Effective from</TableHead>
                    <TableHead>Until</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>

                </TableHeader>
                <TableBody>
                  {members.map((member) => {
                    const closed = !!member.effective_to;
                    return (
                      <TableRow key={member.id} className={closed ? "opacity-60" : undefined}>
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
                          {closed || !canManage ? (
                            CONSOLIDATION_METHOD_LABELS[member.method]
                          ) : (
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
                          )}
                        </TableCell>
                        <TableCell>
                          {businessCurrency(member.business_id) ===
                          activeGroup.presentation_currency ? (
                            <span className="text-muted-foreground">
                              same currency
                            </span>
                          ) : closed || !canManage ? (
                            member.historical_rate_date ?? member.effective_from
                          ) : (
                            <Input
                              type="date"
                              className="h-8 w-[150px]"
                              value={member.historical_rate_date ?? member.effective_from}
                              onChange={async (e) => {
                                const value = e.target.value;
                                if (!value) return;
                                try {
                                  await updateMember.mutateAsync({
                                    id: member.id,
                                    historical_rate_date: value,
                                  });
                                } catch (error) {
                                  fail(error, "Could not update the rate date");
                                }
                              }}
                            />
                          )}
                        </TableCell>
                        <TableCell>{member.effective_from}</TableCell>

                        <TableCell>
                          {closed ? (
                            <Badge variant="outline">closed {member.effective_to}</Badge>
                          ) : (
                            <span className="text-muted-foreground">open</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {canManage &&
                            !closed &&
                            member.business_id !== activeGroup.parent_business_id && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="End this membership today"
                                onClick={async () => {
                                  try {
                                    await closeMember.mutateAsync({
                                      id: member.id,
                                      effectiveTo: today(),
                                    });
                                    toast({ title: "Membership closed" });
                                  } catch (error) {
                                    fail(error, "Could not close the membership");
                                  }
                                }}
                              >
                                <CalendarOff className="h-4 w-4" />
                              </Button>
                            )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {members.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-muted-foreground">
                        No entities in this group yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {canManage && (
              <div className="grid gap-3 sm:grid-cols-6 border-t pt-4">
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
                      <SelectValue placeholder="Parent" />
                    </SelectTrigger>
                    <SelectContent>
                      {openMembers.map((m) => (
                        <SelectItem key={m.id} value={m.business_id}>
                          {businessName(m.business_id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="member-ownership">Ownership %</Label>
                  <Input
                    id="member-ownership"
                    inputMode="decimal"
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
                <div className="space-y-1.5">
                  <Label htmlFor="member-from">Effective from</Label>
                  <Input
                    id="member-from"
                    type="date"
                    value={memberFrom}
                    onChange={(e) => setMemberFrom(e.target.value)}
                  />
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
            )}
          </CardContent>
        </Card>
      )}

      {activeGroup && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Coins className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Currency translation</CardTitle>
                <CardDescription>
                  Companies kept in another currency are restated into{" "}
                  {activeGroup.presentation_currency} at report time. The
                  difference that restatement creates is held in a reserve
                  account of the parent company — it is never spread across the
                  figures it came from.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {foreignMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Every company in this group already keeps its books in{" "}
                {activeGroup.presentation_currency}, so nothing needs
                translating.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Translated at report time:{" "}
                  {foreignMembers
                    .map(
                      (m) =>
                        `${businessName(m.business_id)} (${businessCurrency(m.business_id)})`,
                    )
                    .join(", ")}
                  .
                </p>

                {!activeGroup.cta_account_id && (
                  <Alert variant="destructive">
                    <Info className="h-4 w-4" />
                    <AlertDescription>
                      Consolidated reports for this group are blocked until a
                      translation reserve account is chosen. Without somewhere
                      to hold the translation difference, the consolidated
                      figures would not balance.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Translation reserve account</Label>
                    <Select
                      value={activeGroup.cta_account_id ?? ""}
                      disabled={!canManage}
                      onValueChange={async (value) => {
                        try {
                          await updateGroupTranslationSettings.mutateAsync({
                            id: activeGroup.id,
                            cta_account_id: value,
                          });
                          toast({ title: "Translation reserve account saved" });
                        } catch (error) {
                          fail(error, "Could not save the reserve account");
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select an equity account" />
                      </SelectTrigger>
                      <SelectContent>
                        {ctaAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.code} — {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      An equity account of{" "}
                      {businessName(activeGroup.parent_business_id)}. Reserves
                      of the companies being translated cannot be used.
                    </p>
                    {ctaAccounts.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        The parent company has no equity account available yet —
                        add one in its chart of accounts first.
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}


      {activeGroup && (
        <ConsolidationAccountMapping
          groupId={activeGroup.id}
          groupName={activeGroup.name}
          canManage={canManage}
          members={openMembers.map((m) => ({
            business_id: m.business_id,
            name: businessName(m.business_id),
          }))}
        />
      )}


      {activeGroup && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <History className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">Configuration history</CardTitle>
                <CardDescription>
                  Every change to this group and its companies, newest first.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead>Company</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {changeLog.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap">
                        {new Date(entry.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell>{entry.entity === "group" ? "Group" : "Company"}</TableCell>
                      <TableCell>{entry.action}</TableCell>
                      <TableCell>
                        {entry.business_id ? businessName(entry.business_id) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {changeLog.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground">
                        No changes recorded yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default ConsolidationGroupsSettings;
