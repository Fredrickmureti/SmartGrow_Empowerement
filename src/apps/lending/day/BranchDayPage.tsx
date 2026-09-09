/**
 * Lending → Branch day.
 *
 * The branch's trading day, start to finish: open it with the cash in the box,
 * see what the ledger says should be there as the day runs, close it against a
 * physical count, and read the register of past days. Every rule is enforced
 * by the database — this page only surfaces the state and calls the RPCs.
 */
import { useMemo, useState } from "react";
import { CalendarClock, LockOpen, Lock, RotateCcw } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { usePermissions } from "@/hooks/usePermissions";
import { useCurrency } from "@/hooks/useCurrency";
import {
  useBranchDays,
  useOpenBranchDay,
  useExpectedCash,
  todayIso,
  type BranchOperationalDay,
} from "@/hooks/useBranchDay";

export function BranchDayPage() {
  const { can } = usePermissions();
  const canManage = can("recordRepayments");
  const { branches, currentBranch } = useBranches();
  const { getUserName } = useOrgMembers();
  const { formatCurrency } = useCurrency();

  const [branchId, setBranchId] = useState<string>(
    () => currentBranch?.id ?? branches[0]?.id ?? "",
  );

  const { days, isLoading, error, openDay, closeDay, reopenDay } = useBranchDays({
    branchId: branchId || null,
  });
  const { data: openDayRow } = useOpenBranchDay(branchId || null);
  const { data: expectedCash } = useExpectedCash(openDayRow?.id ?? null);

  const [openFormOpen, setOpenFormOpen] = useState(false);
  const [openingCash, setOpeningCash] = useState("0");
  const [openDate, setOpenDate] = useState(todayIso());
  const [openNotes, setOpenNotes] = useState("");

  const [closeFormOpen, setCloseFormOpen] = useState(false);
  const [countedCash, setCountedCash] = useState("");
  const [varianceReason, setVarianceReason] = useState("");
  const [closeNotes, setCloseNotes] = useState("");

  const [reopenTarget, setReopenTarget] = useState<BranchOperationalDay | null>(null);
  const [reopenReason, setReopenReason] = useState("");

  const branch = branches.find((b) => b.id === branchId) ?? null;
  const dayControlFrom = (branch as { day_control_from?: string | null } | null)
    ?.day_control_from ?? null;

  const counted = Number(countedCash === "" ? NaN : countedCash);
  const liveVariance = useMemo(() => {
    if (Number.isNaN(counted) || expectedCash == null) return null;
    return counted - expectedCash;
  }, [counted, expectedCash]);

  const submitOpen = async () => {
    if (!branchId) return;
    await openDay.mutateAsync({
      branchId,
      businessDate: openDate || null,
      openingCash: Number(openingCash || 0),
      notes: openNotes.trim() || null,
    });
    setOpenFormOpen(false);
    setOpeningCash("0");
    setOpenNotes("");
  };

  const submitClose = async () => {
    if (!openDayRow || Number.isNaN(counted)) return;
    await closeDay.mutateAsync({
      dayId: openDayRow.id,
      countedCash: counted,
      varianceReason: varianceReason.trim() || null,
      notes: closeNotes.trim() || null,
    });
    setCloseFormOpen(false);
    setCountedCash("");
    setVarianceReason("");
    setCloseNotes("");
  };

  const submitReopen = async () => {
    if (!reopenTarget || !reopenReason.trim()) return;
    await reopenDay.mutateAsync({
      dayId: reopenTarget.id,
      reason: reopenReason.trim(),
    });
    setReopenTarget(null);
    setReopenReason("");
  };

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Branch day"
        description="Open the branch for the day, watch the cash position, and close it against a physical count."
      />
      <PageBody>
        <Section
          title={
            openDayRow
              ? `Open since ${openDayRow.business_date}`
              : "No day is open at this branch"
          }
          description={
            dayControlFrom
              ? `Day control has applied at this branch since ${dayControlFrom}.`
              : "Day control is not switched on for this branch yet, so transactions are not restricted by the day."
          }
        >
          <FilterBar>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="w-[240px]">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManage && !openDayRow && (
              <Button onClick={() => setOpenFormOpen(true)} disabled={!branchId}>
                <LockOpen className="mr-1.5 h-4 w-4" />
                Open the day
              </Button>
            )}
            {canManage && openDayRow && (
              <Button variant="destructive" onClick={() => setCloseFormOpen(true)}>
                <Lock className="mr-1.5 h-4 w-4" />
                Close the day
              </Button>
            )}
          </FilterBar>

          {openDayRow && (
            <div className="grid gap-3 sm:grid-cols-3">
              <SummaryTile
                label="Cash at open"
                value={formatCurrency(Number(openDayRow.opening_cash ?? 0))}
              />
              <SummaryTile
                label="Cash the books expect now"
                value={
                  expectedCash == null ? "…" : formatCurrency(Number(expectedCash))
                }
              />
              <SummaryTile
                label="Opened by"
                value={
                  openDayRow.opened_by ? getUserName(openDayRow.opened_by) : "—"
                }
              />
            </div>
          )}
        </Section>

        <Section title="Day register" description="Past days at this branch.">
          {isLoading ? (
            <LoadingState />
          ) : error ? (
            <ErrorState error={error as Error} />
          ) : days.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No days recorded yet"
              description="Once a day is opened at this branch it appears here with its cash count."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Opening</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead className="text-right">Over / short</TableHead>
                  <TableHead>Closed by</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {days.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.business_date}</TableCell>
                    <TableCell>
                      <StatusBadge
                        status={d.status === "open" ? "Open" : "Closed"}
                        tone={d.status === "open" ? "success" : "neutral"}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(Number(d.opening_cash ?? 0))}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.expected_cash == null
                        ? "—"
                        : formatCurrency(Number(d.expected_cash))}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.counted_cash == null
                        ? "—"
                        : formatCurrency(Number(d.counted_cash))}
                    </TableCell>
                    <TableCell
                      className={`text-right ${
                        Number(d.variance ?? 0) !== 0 ? "text-destructive" : ""
                      }`}
                    >
                      {d.variance == null ? "—" : formatCurrency(Number(d.variance))}
                    </TableCell>
                    <TableCell>
                      {d.closed_by ? getUserName(d.closed_by) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && d.status === "closed" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setReopenTarget(d)}
                        >
                          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                          Reopen
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      {/* Open */}
      <Dialog open={openFormOpen} onOpenChange={setOpenFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open the day</DialogTitle>
            <DialogDescription>
              Count the cash in the box before anything is collected, and record it here.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="day-date">Date</Label>
              <Input
                id="day-date"
                type="date"
                value={openDate}
                onChange={(e) => setOpenDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="day-opening">Cash in the box</Label>
              <Input
                id="day-opening"
                type="number"
                inputMode="decimal"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="day-notes">Notes (optional)</Label>
              <Textarea
                id="day-notes"
                value={openNotes}
                onChange={(e) => setOpenNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitOpen} disabled={openDay.isPending}>
              Open the day
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close */}
      <Dialog open={closeFormOpen} onOpenChange={setCloseFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close the day</DialogTitle>
            <DialogDescription>
              Count the cash physically in the box and enter it. Anything over or short is
              recorded against the day.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              The books expect{" "}
              <span className="font-medium">
                {expectedCash == null ? "…" : formatCurrency(Number(expectedCash))}
              </span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="day-counted">Cash counted</Label>
              <Input
                id="day-counted"
                type="number"
                inputMode="decimal"
                value={countedCash}
                onChange={(e) => setCountedCash(e.target.value)}
              />
            </div>
            {liveVariance !== null && liveVariance !== 0 && (
              <>
                <p className="text-sm text-destructive">
                  {liveVariance > 0 ? "Over" : "Short"} by{" "}
                  {formatCurrency(Math.abs(liveVariance))}. A reason is required.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="day-reason">Reason</Label>
                  <Textarea
                    id="day-reason"
                    value={varianceReason}
                    onChange={(e) => setVarianceReason(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="day-close-notes">Notes (optional)</Label>
              <Textarea
                id="day-close-notes"
                value={closeNotes}
                onChange={(e) => setCloseNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseFormOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitClose}
              disabled={
                closeDay.isPending ||
                Number.isNaN(counted) ||
                (liveVariance !== null && liveVariance !== 0 && !varianceReason.trim())
              }
            >
              Close the day
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reopen */}
      <Dialog
        open={!!reopenTarget}
        onOpenChange={(o) => {
          if (!o) setReopenTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen {reopenTarget?.business_date}</DialogTitle>
            <DialogDescription>
              Reopening a closed day is recorded against your name and kept in the day's
              history. Say why it is being reopened.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="day-reopen-reason">Reason</Label>
            <Textarea
              id="day-reopen-reason"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitReopen}
              disabled={reopenDay.isPending || !reopenReason.trim()}
            >
              Reopen the day
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

export default BranchDayPage;
