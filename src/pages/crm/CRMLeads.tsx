// @ts-nocheck
/**
 * CRM Leads — list view.
 *
 * The kanban board can only show opportunities that sit in a stage, so a lead
 * created before stages exist (or one whose stage was archived) is invisible
 * there while still counting towards the pipeline totals. Mainstream CRMs solve
 * this with a list view that always shows every opportunity regardless of
 * stage; this page is that surface and is the canonical place to search,
 * inspect and edit leads.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Archive, Plus, Search, TriangleAlert, Users } from "lucide-react";
import { useCRMStages, useLeads, type Lead } from "@/hooks/crm";
import { LeadForm } from "@/components/crm/LeadForm";
import { LeadDetailsDialog } from "@/components/crm/LeadDetailsDialog";
import { ArchivedLeadsDialog } from "@/components/crm/ArchivedLeadsDialog";
import { PermissionGate } from "@/components/common/PermissionGate";
import { useCurrency } from "@/hooks/useCurrency";
import { useNavigate, useSearchParams } from "react-router-dom";

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  qualified: "Qualified",
  proposition: "Proposition",
  won: "Won",
  lost: "Lost",
};

export default function CRMLeads() {
  const { stages } = useCRMStages();
  const { leads, isLoading, deleteLead, refreshLeads } = useLeads();
  const { formatCurrency, baseCurrency } = useCurrency();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  /**
   * Deep links. Other modules (projects, "originated from lead" badges, the
   * global create menu) point at a specific lead or at lead capture; the list
   * is the surface that can always honour that, including for a lead that has
   * no stage and therefore no card on the board.
   */
  const deepLinkId = searchParams.get("lead");
  const wantsCreate = searchParams.get("action") === "create";

  useEffect(() => {
    if (wantsCreate) {
      setShowLeadForm(true);
      const next = new URLSearchParams(searchParams);
      next.delete("action");
      setSearchParams(next, { replace: true });
    }
  }, [wantsCreate]);

  useEffect(() => {
    if (!deepLinkId || isLoading) return;
    const match = leads.find((l) => l.id === deepLinkId);
    if (match) {
      setSelectedLead(match);
      setStatusFilter("all");
    }
    const next = new URLSearchParams(searchParams);
    next.delete("lead");
    setSearchParams(next, { replace: true });
  }, [deepLinkId, isLoading, leads]);

  const unstagedCount = leads.filter((l) => !l.stage_id && l.status !== "won" && l.status !== "lost").length;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (statusFilter === "open" && (lead.status === "won" || lead.status === "lost")) return false;
      if (statusFilter !== "open" && statusFilter !== "all" && lead.status !== statusFilter) return false;
      if (stageFilter === "none" && lead.stage_id) return false;
      if (stageFilter !== "all" && stageFilter !== "none" && lead.stage_id !== stageFilter) return false;
      if (!term) return true;
      return [
        lead.name,
        lead.lead_number,
        lead.contact_name,
        lead.company_contact?.name,
        lead.email,
        lead.phone,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
  }, [leads, search, statusFilter, stageFilter]);

  const totalValue = filtered
    .filter((l) => !l.currency || l.currency === baseCurrency)
    .reduce((sum, l) => sum + (l.expected_revenue || 0), 0);

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Leads</h1>
            <p className="text-muted-foreground">
              Every opportunity, including ones not yet placed on the board
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowArchived(true)}>
              <Archive className="mr-2 h-4 w-4" />
              Archived
            </Button>
            <PermissionGate permission="manageSales">
              <Button onClick={() => setShowLeadForm(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New Lead
              </Button>
            </PermissionGate>
          </div>
        </div>

        {unstagedCount > 0 && (
          <Alert>
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>
              {unstagedCount} lead{unstagedCount === 1 ? "" : "s"} without a pipeline stage
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {stages.length === 0
                  ? "Your pipeline has no stages yet, so there is nowhere to place them. Set up the funnel first, then assign each lead a stage from its record."
                  : "They do not appear on the kanban board until a stage is set. Open the lead and pick a stage — leads created from now on are placed in the first open stage automatically."}
              </p>
              <div className="flex flex-wrap gap-2">
                {stages.length === 0 ? (
                  <Button size="sm" variant="outline" onClick={() => navigate("/crm-app/pipeline")}>
                    Set up pipeline
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setStageFilter("none")}
                  >
                    Show these leads
                  </Button>
                )}
              </div>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          <Card className="border-l-4 border-l-primary">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Leads Shown
                </CardTitle>
                <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="stat-value tabular-nums whitespace-nowrap">{filtered.length}</div>
              <p className="mt-1 text-xs text-muted-foreground">of {leads.length} total</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-emerald-500">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Value Shown
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="stat-value text-emerald-600 tabular-nums whitespace-nowrap">
                {formatCurrency(totalValue, baseCurrency)}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{baseCurrency} amounts only</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, number, contact, company, email…"
                  className="pl-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="sm:w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="qualified">Qualified</SelectItem>
                  <SelectItem value="proposition">Proposition</SelectItem>
                  <SelectItem value="won">Won</SelectItem>
                  <SelectItem value="lost">Lost</SelectItem>
                </SelectContent>
              </Select>
              <Select value={stageFilter} onValueChange={setStageFilter}>
                <SelectTrigger className="sm:w-[180px]">
                  <SelectValue placeholder="All stages" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All stages</SelectItem>
                  <SelectItem value="none">No stage</SelectItem>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
              /* Each empty condition is a different business situation and gets
                 its own explanation and next step — collapsing them into one
                 generic message is how the "missing lead" report started. */
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <Users className="h-10 w-10 text-muted-foreground" />
                {leads.length === 0 ? (
                  <>
                    <p className="font-medium">No leads yet</p>
                    <p className="max-w-md text-sm text-muted-foreground">
                      Capture your first opportunity and it will appear here, on the pipeline
                      board and in your CRM statistics.
                    </p>
                    <PermissionGate permission="manageSales">
                      <Button onClick={() => setShowLeadForm(true)}>
                        <Plus className="mr-2 h-4 w-4" />
                        New Lead
                      </Button>
                    </PermissionGate>
                    <Button variant="ghost" size="sm" onClick={() => setShowArchived(true)}>
                      Check archived leads
                    </Button>
                  </>
                ) : stages.length === 0 ? (
                  <>
                    <p className="font-medium">No pipeline stages configured</p>
                    <p className="max-w-md text-sm text-muted-foreground">
                      Your leads exist but your funnel has not been set up yet, so no stage
                      filter can match. Set up the pipeline, then place each lead in a stage.
                    </p>
                    <Button variant="outline" onClick={() => navigate("/crm-app/pipeline")}>
                      Set up pipeline
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="font-medium">No leads match these filters</p>
                    <p className="max-w-md text-sm text-muted-foreground">
                      {leads.length} lead{leads.length === 1 ? "" : "s"} exist in this company.
                      Clear the filters to see them all.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch("");
                        setStatusFilter("all");
                        setStageFilter("all");
                      }}
                    >
                      Clear filters
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Lead</TableHead>
                      <TableHead className="hidden md:table-cell">Customer</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead className="hidden sm:table-cell">Status</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="hidden lg:table-cell text-right">Prob.</TableHead>
                      <TableHead className="hidden lg:table-cell">Close date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((lead) => {
                      const stage = stages.find((s) => s.id === lead.stage_id);
                      return (
                        <TableRow
                          key={lead.id}
                          className="cursor-pointer"
                          onClick={() => setSelectedLead(lead)}
                        >
                          <TableCell>
                            <div className="font-medium">{lead.name}</div>
                            <div className="text-xs text-muted-foreground">{lead.lead_number}</div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <div className="text-sm">{lead.company_contact?.name || lead.contact_name || "—"}</div>
                            {lead.email && (
                              <div className="text-xs text-muted-foreground">{lead.email}</div>
                            )}
                          </TableCell>
                          <TableCell>
                            {stage ? (
                              <Badge variant="outline" className="whitespace-nowrap">
                                {stage.name}
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="whitespace-nowrap">
                                No stage
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            <Badge
                              variant={
                                lead.status === "won"
                                  ? "default"
                                  : lead.status === "lost"
                                    ? "destructive"
                                    : "outline"
                              }
                            >
                              {STATUS_LABEL[lead.status] || lead.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums whitespace-nowrap">
                            {formatCurrency(lead.expected_revenue || 0, lead.currency || baseCurrency)}
                          </TableCell>
                          <TableCell className="hidden lg:table-cell text-right tabular-nums">
                            {lead.probability != null ? `${lead.probability}%` : "—"}
                          </TableCell>
                          <TableCell className="hidden lg:table-cell whitespace-nowrap">
                            {lead.expected_close_date
                              ? new Date(lead.expected_close_date).toLocaleDateString()
                              : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <LeadForm
        open={showLeadForm}
        onOpenChange={(open) => {
          setShowLeadForm(open);
          if (!open) refreshLeads();
        }}
      />

      <LeadDetailsDialog
        lead={selectedLead}
        open={!!selectedLead}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedLead(null);
            refreshLeads();
          }
        }}
        onDelete={async (leadId, reason, version) => {
          await deleteLead(leadId, reason, version);
          setSelectedLead(null);
          await refreshLeads();
        }}
      />

      <ArchivedLeadsDialog
        open={showArchived}
        onOpenChange={setShowArchived}
        onRestored={refreshLeads}
      />
    </>
  );
}
