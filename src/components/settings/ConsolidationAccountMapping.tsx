/**
 * Group chart of accounts and account mapping (Brick 4 configuration surface).
 *
 * Each member company keeps its own chart of accounts. This screen defines the
 * *group's* chart and links every member account to a line of it, which is what
 * turns a stack of member ledgers into a consolidated statement.
 *
 * This screen computes nothing. Aggregation and refusal both live in the
 * reporting engine: a period where a member account carrying posted activity
 * has no mapping is refused outright, because such a balance would otherwise
 * either vanish from the group totals or sit on a line of its own that nobody
 * can reconcile to the group chart.
 *
 * Invariants mirrored from the database guards, so the UI never offers an
 * action the database will reject:
 * - a member account may only map to a group account of the same type;
 * - mappings are effective-dated and closed with a date, never deleted, so a
 *   past-period consolidation stays reproducible.
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
import { AlertTriangle, Info, Link2, Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import {
  GROUP_ACCOUNT_TYPES,
  GROUP_ACCOUNT_TYPE_LABELS,
  useConsolidationAccountMappings,
  useConsolidationGroupAccounts,
  useConsolidationMappingMutations,
  useConsolidationMemberAccounts,
  useConsolidationUnmappedAccounts,
  type GroupAccountType,
} from "@/hooks/finance/useConsolidationAccountMapping";

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;

interface Props {
  groupId: string;
  groupName: string;
  canManage: boolean;
  /** Open member companies of the group, in display order. */
  members: { business_id: string; name: string }[];
}

export function ConsolidationAccountMapping({
  groupId,
  groupName,
  canManage,
  members,
}: Props) {
  const { toast } = useToast();
  const businessIds = useMemo(() => members.map((m) => m.business_id), [members]);

  const { data: groupAccounts = [], isLoading: chartLoading } =
    useConsolidationGroupAccounts(groupId);
  const { data: mappings = [] } = useConsolidationAccountMappings(groupId);
  const { data: memberAccounts = [], isLoading: accountsLoading } =
    useConsolidationMemberAccounts(businessIds);
  const {
    createGroupAccount,
    deleteGroupAccount,
    mapAccount,
    remapAccount,
    closeMapping,
  } = useConsolidationMappingMutations();

  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<GroupAccountType>("asset");

  const [dateFrom, setDateFrom] = useState(monthStart);
  const [dateTo, setDateTo] = useState(today);
  const unmappedQuery = useConsolidationUnmappedAccounts(groupId, dateFrom, dateTo);

  const [filterBusiness, setFilterBusiness] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "mapped" | "unmapped">("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  /** Mappings currently in force, keyed by the member account they cover. */
  const openMappingByAccount = useMemo(() => {
    const map = new Map<string, (typeof mappings)[number]>();
    for (const m of mappings) {
      if (m.effective_to) continue;
      map.set(m.account_id, m);
    }
    return map;
  }, [mappings]);

  const activeGroupAccounts = useMemo(
    () => groupAccounts.filter((a) => a.is_active),
    [groupAccounts],
  );

  const businessName = (id: string) =>
    members.find((m) => m.business_id === id)?.name ?? "—";

  const visibleAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return memberAccounts
      .filter((a) => filterBusiness === "all" || a.business_id === filterBusiness)
      .filter((a) => filterType === "all" || a.account_type === filterType)
      .filter((a) => {
        if (filterStatus === "all") return true;
        const mapped = openMappingByAccount.has(a.id);
        return filterStatus === "mapped" ? mapped : !mapped;
      })
      .filter((a) => {
        if (!q) return true;
        return (
          (a.code ?? "").toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q) ||
          businessName(a.business_id).toLowerCase().includes(q)
        );
      })
      .sort(
        (a, b) =>
          businessName(a.business_id).localeCompare(businessName(b.business_id)) ||
          (a.code ?? "").localeCompare(b.code ?? ""),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    memberAccounts,
    filterBusiness,
    filterType,
    filterStatus,
    search,
    members,
    openMappingByAccount,
  ]);

  const mappedCount = visibleAccounts.filter((a) =>
    openMappingByAccount.has(a.id),
  ).length;

  // A group with a handful of companies easily reaches four figures of member
  // accounts; rendering them all is unusable and janky. Page the rows.
  const pageCount = Math.max(1, Math.ceil(visibleAccounts.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pagedAccounts = visibleAccounts.slice(
    safePage * pageSize,
    safePage * pageSize + pageSize,
  );

  const fail = (error: unknown, fallback: string) =>
    toast({
      title: fallback,
      description: normalizeError(error).message,
      variant: "destructive",
    });

  const handleCreateGroupAccount = async () => {
    if (!newCode.trim() || !newName.trim()) return;
    try {
      await createGroupAccount.mutateAsync({
        group_id: groupId,
        code: newCode.trim(),
        name: newName.trim(),
        account_type: newType,
        sort_order: groupAccounts.length,
      });
      setNewCode("");
      setNewName("");
      toast({ title: "Group account added" });
    } catch (error) {
      fail(error, "Could not add the group account");
    }
  };

  const handleMap = async (
    account: { id: string; business_id: string },
    groupAccountId: string,
  ) => {
    const existing = openMappingByAccount.get(account.id);
    try {
      if (existing) {
        if (existing.group_account_id === groupAccountId) return;
        await remapAccount.mutateAsync({
          id: existing.id,
          group_account_id: groupAccountId,
        });
      } else {
        await mapAccount.mutateAsync({
          group_id: groupId,
          business_id: account.business_id,
          account_id: account.id,
          group_account_id: groupAccountId,
        });
      }
      toast({ title: "Mapping saved" });
    } catch (error) {
      fail(error, "Could not save the mapping");
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Link2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">
                {groupName} — group chart of accounts
              </CardTitle>
              <CardDescription>
                The lines the consolidated statements are built from. Each member
                account is mapped to one of these, so the same economic account in
                two companies reports as one figure.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Mapped accounts</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {chartLoading && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      Loading the group chart…
                    </TableCell>
                  </TableRow>
                )}
                {groupAccounts.map((account) => {
                  const linked = mappings.filter(
                    (m) => !m.effective_to && m.group_account_id === account.id,
                  ).length;
                  return (
                    <TableRow key={account.id} className={account.is_active ? undefined : "opacity-60"}>
                      <TableCell className="font-medium tabular-nums">
                        {account.code}
                      </TableCell>
                      <TableCell>{account.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {GROUP_ACCOUNT_TYPE_LABELS[account.account_type]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{linked}</TableCell>
                      <TableCell>
                        {canManage && linked === 0 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Remove this group account"
                            onClick={async () => {
                              try {
                                await deleteGroupAccount.mutateAsync(account.id);
                                toast({ title: "Group account removed" });
                              } catch (error) {
                                fail(error, "Could not remove the group account");
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!chartLoading && groupAccounts.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      No group accounts yet. Consolidated reports stay blocked until
                      every posted member account can be mapped.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {canManage && (
            <div className="grid gap-3 border-t pt-4 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="ga-code">Code</Label>
                <Input
                  id="ga-code"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  placeholder="e.g. 1000"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ga-name">Name</Label>
                <Input
                  id="ga-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Cash and cash equivalents"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select
                  value={newType}
                  onValueChange={(v) => setNewType(v as GroupAccountType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GROUP_ACCOUNT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {GROUP_ACCOUNT_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full gap-2"
                  onClick={handleCreateGroupAccount}
                  disabled={
                    !newCode.trim() || !newName.trim() || createGroupAccount.isPending
                  }
                >
                  {createGroupAccount.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Add group account
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Map member accounts</CardTitle>
          <CardDescription>
            A member account may only map to a group account of the same type — an
            expense cannot be reported inside a liability. Changing a mapping ends
            the previous one with today's date rather than erasing it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeGroupAccounts.length === 0 ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                Add group accounts above before mapping.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="map-search">Search</Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="map-search"
                      className="w-[260px] pl-8"
                      placeholder="Code, account or company…"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(0);
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Company</Label>
                  <Select
                    value={filterBusiness}
                    onValueChange={(v) => {
                      setFilterBusiness(v);
                      setPage(0);
                    }}
                  >
                    <SelectTrigger className="w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All companies</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.business_id} value={m.business_id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select
                    value={filterType}
                    onValueChange={(v) => {
                      setFilterType(v);
                      setPage(0);
                    }}
                  >
                    <SelectTrigger className="w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      {GROUP_ACCOUNT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {GROUP_ACCOUNT_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <Select
                    value={filterStatus}
                    onValueChange={(v) => {
                      setFilterStatus(v as typeof filterStatus);
                      setPage(0);
                    }}
                  >
                    <SelectTrigger className="w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All accounts</SelectItem>
                      <SelectItem value="unmapped">Not mapped</SelectItem>
                      <SelectItem value="mapped">Mapped</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="pb-2 text-sm text-muted-foreground">
                  {mappedCount} of {visibleAccounts.length} accounts mapped
                </p>
              </div>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Member account</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Group account</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accountsLoading && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-muted-foreground">
                          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                          Loading member accounts…
                        </TableCell>
                      </TableRow>
                    )}
                    {visibleAccounts.map((account) => {
                      const mapping = openMappingByAccount.get(account.id);
                      const options = activeGroupAccounts.filter(
                        (g) => g.account_type === account.account_type,
                      );
                      return (
                        <TableRow key={account.id}>
                          <TableCell>{businessName(account.business_id)}</TableCell>
                          <TableCell className="font-medium">
                            {account.code ? `${account.code} — ` : ""}
                            {account.name}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {GROUP_ACCOUNT_TYPE_LABELS[account.account_type]}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {!canManage ? (
                              mapping ? (
                                (activeGroupAccounts.find(
                                  (g) => g.id === mapping.group_account_id,
                                )?.name ?? "mapped")
                              ) : (
                                <Badge variant="destructive">Not mapped</Badge>
                              )
                            ) : options.length === 0 ? (
                              <span className="text-xs text-muted-foreground">
                                No {GROUP_ACCOUNT_TYPE_LABELS[account.account_type].toLowerCase()}{" "}
                                group account defined yet
                              </span>
                            ) : (
                              <Select
                                value={mapping?.group_account_id ?? ""}
                                onValueChange={(value) => handleMap(account, value)}
                              >
                                <SelectTrigger className="h-8 w-[300px]">
                                  <SelectValue placeholder="Not mapped" />
                                </SelectTrigger>
                                <SelectContent>
                                  {options.map((g) => (
                                    <SelectItem key={g.id} value={g.id}>
                                      {g.code} — {g.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </TableCell>
                          <TableCell>
                            {canManage && mapping && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="End this mapping today"
                                onClick={async () => {
                                  try {
                                    await closeMapping.mutateAsync({
                                      id: mapping.id,
                                      effectiveTo: today(),
                                    });
                                    toast({ title: "Mapping ended" });
                                  } catch (error) {
                                    fail(error, "Could not end the mapping");
                                  }
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {!accountsLoading && visibleAccounts.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-muted-foreground">
                          No postable accounts found for the companies in this group.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unmapped balances for a period</CardTitle>
          <CardDescription>
            Accounts with posted activity that map to nothing. Consolidated reports
            for the period are refused while this list is not empty — a balance with
            no group account would misstate the group totals.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="unmapped-from">From</Label>
              <Input
                id="unmapped-from"
                type="date"
                className="w-[170px]"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="unmapped-to">To</Label>
              <Input
                id="unmapped-to"
                type="date"
                className="w-[170px]"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>

          {unmappedQuery.error ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {normalizeError(unmappedQuery.error).message}
              </AlertDescription>
            </Alert>
          ) : unmappedQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
              Checking the period…
            </p>
          ) : (unmappedQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every account with activity in this period is mapped to the group chart.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Closing balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(unmappedQuery.data ?? []).map((row) => (
                    <TableRow key={`${row.business_id}:${row.account_id}`}>
                      <TableCell>{row.business_name}</TableCell>
                      <TableCell className="font-medium">
                        {row.account_code ? `${row.account_code} — ` : ""}
                        {row.account_name}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {GROUP_ACCOUNT_TYPE_LABELS[row.account_type]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Number(row.closing_balance).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default ConsolidationAccountMapping;
