import { useState } from "react";
import { WorkflowSheet } from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Mail,
  Phone,
  Building2,
  Calendar,
  Star,
  ChevronDown,
  UserPlus,
  FileText,
  ShoppingCart,
  FolderKanban,
  Trophy,
  XCircle,
  Loader2,
  Activity,
  History,
  Info,
  Trash2,
  ExternalLink,
  Send,
  Undo2,
  RotateCcw,

} from "lucide-react";

import { format } from "date-fns";
import { Lead, useLeads } from "@/hooks/crm/useLeads";
import { useCRMActivities } from "@/hooks/crm/useCRMActivities";
import { useNavigate } from "react-router-dom";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { useCurrency } from "@/hooks/useCurrency";
import { MarkAsWonDialog } from "./MarkAsWonDialog";
import { LeadItemsEditor } from "./LeadItemsEditor";

import { MarkAsLostDialog } from "./MarkAsLostDialog";
import { ScheduleActivityDialog } from "./ScheduleActivityDialog";
import { ActivityTimeline } from "./ActivityTimeline";
import { LeadHistoryTimeline } from "./LeadHistoryTimeline";
import { ReasonDialog } from "./ReasonDialog";


import { CRMActivity } from "@/hooks/crm/useCRMActivities";
import { toast } from "sonner";
import { useBranch } from "@/contexts/BranchContext";
import { normalizeError } from "@/services/resilience";

interface LeadDetailsDialogProps {
  lead: Lead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete?: (leadId: string, reason?: string, version?: number | null) => Promise<void>;
}

export function LeadDetailsDialog({
  lead,
  open,
  onOpenChange,
  onDelete,
}: LeadDetailsDialogProps) {
  const navigate = useNavigate();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { formatCurrency, baseCurrency } = useCurrency();
  const {
    markAsWon,
    markAsLost,
    markAsProposition,
    withdrawProposition,
    reopenLead,
    deleteLead: deleteLeadFromHook,
    convertToContact,
    convertToEstimate,
    convertToSalesOrder,
    convertToProject,
    transferBranch,
    refreshLeads,
  } = useLeads();
  const { branches, hasMultipleBranches } = useBranch();
  const [isTransferring, setIsTransferring] = useState(false);

  /**
   * Branch moves are a governed server operation — the RPC re-checks access,
   * business match and lifecycle state, so failures are surfaced verbatim.
   */
  const handleTransferBranch = async (branchId: string) => {
    setIsTransferring(true);
    try {
      await transferBranch(lead.id, branchId);
      await refreshLeads();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not transfer this opportunity");
    } finally {
      setIsTransferring(false);
    }
  };

  // Use the passed onDelete prop if available, otherwise fall back to the hook's deleteLead
  const deleteLead = onDelete || deleteLeadFromHook;

  const {
    activities,
    isLoading: activitiesLoading,
    createActivity,
    updateActivity,
    markAsDone,
    deleteActivity,
  } = useCRMActivities(lead?.id);

  const [isConverting, setIsConverting] = useState(false);
  const [showWonDialog, setShowWonDialog] = useState(false);
  const [showLostDialog, setShowLostDialog] = useState(false);
  const [showActivityDialog, setShowActivityDialog] = useState(false);
  
  const [isDeleting, setIsDeleting] = useState(false);
  const [showWithdrawDialog, setShowWithdrawDialog] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showReopenDialog, setShowReopenDialog] = useState(false);
  const [editingActivity, setEditingActivity] = useState<CRMActivity | undefined>();
  const [isMovingStage, setIsMovingStage] = useState(false);

  if (!lead) return null;

  /**
   * Selectable stages exclude the terminal ones: Won has its own authoritative
   * operation and Lost requires a reason, so they cannot be reached by a plain
   * stage move (the server refuses them anyway).
   */
  const openStages = stages.filter((s) => !s.is_won && !s.is_lost);

  const handleChangeStage = async (stageId: string) => {
    if (isReadOnly) {
      openUpgradeModal("crm");
      return;
    }
    if (!stageId || stageId === lead.stage_id) return;
    setIsMovingStage(true);
    try {
      await moveToStage(lead.id, stageId, lead.version);
      toast.success("Stage updated");
      await refreshLeads();
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Could not move this opportunity");
    } finally {
      setIsMovingStage(false);
    }
  };

  const handleAction = async (action: () => Promise<any>) => {
    if (isReadOnly) {
      openUpgradeModal("crm");
      return;
    }
    setIsConverting(true);
    try {
      await action();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Action failed:", error);
      toast.error(normalizeError(error).message || "An error occurred while processing your request");
    } finally {
      setIsConverting(false);
    }
  };

  const handleConvertToContact = () =>
    handleAction(async () => {
      const contact = await convertToContact(lead.id);
      if (contact) {
        navigate(`/contacts-app/profile?id=${contact.id}`);
      }
    });

  const handleConvertToEstimate = () =>
    handleAction(async () => {
      const estimate = await convertToEstimate(lead.id);
      if (estimate) {
        navigate(`/estimates?edit=${estimate.id}`);
      }
    });

  const handleConvertToSalesOrder = () =>
    handleAction(async () => {
      const order = await convertToSalesOrder(lead.id);
      if (order) {
        navigate(`/sales-orders?edit=${order.id}`);
      }
    });

  const handleConvertToProject = () =>
    handleAction(async () => {
      const project = await convertToProject(lead.id);
      if (project) {
        navigate(`/projects/${project.id}/overview`);
      }
    });

  const handleMarkAsWon = () => {
    if (isReadOnly) {
      openUpgradeModal("crm");
      return;
    }
    setShowWonDialog(true);
  };

  const handleMarkAsLost = () => {
    if (isReadOnly) {
      openUpgradeModal("crm");
      return;
    }
    setShowLostDialog(true);
  };

  const confirmWon = async (options: {
    createContact: boolean;
    create: { estimate: boolean; salesOrder: boolean; project: boolean };
  }) => {
    try {
      const result = await markAsWon(lead.id, options);
      onOpenChange(false);

      // Navigate to the most "downstream" artifact created (project > SO > estimate).
      if (options.create.project && result?.projectId) {
        navigate(`/projects/${result.projectId}/overview`);
      } else if (options.create.salesOrder && result?.salesOrderId) {
        navigate(`/sales-orders?edit=${result.salesOrderId}`);
      } else if (options.create.estimate && result?.estimateId) {
        navigate(`/estimates?edit=${result.estimateId}`);
      }
    } catch (error: any) {
      console.error("Mark as won failed:", error);
      toast.error(normalizeError(error).message || "Failed to mark lead as won");
    }
  };


  const confirmLost = async (reasonId?: string, notes?: string) => {
    await markAsLost(lead.id, reasonId, notes);
    onOpenChange(false);
  };

  const handleScheduleActivity = async (activity: Partial<CRMActivity>) => {
    if (editingActivity) {
      await updateActivity(editingActivity.id, activity);
      setEditingActivity(undefined);
    } else {
      await createActivity(activity);
    }
  };

  const handleEditActivity = (activity: CRMActivity) => {
    setEditingActivity(activity);
    setShowActivityDialog(true);
  };

  const isWonOrLost = lead.won_at || lead.lost_at;
  const isProposition = lead.status === "proposition";

  // Get next pending activity for indicator
  const nextActivity = activities.find((a) => !a.is_done);

  /**
   * Proposition is a real lifecycle state: entering and withdrawing it are
   * separate audited server transitions, each carrying the row version so a
   * stale screen cannot overwrite someone else's move.
   */
  const handleMarkAsProposition = () =>
    handleAction(async () => {
      await markAsProposition(lead.id, lead.version);
    });

  const confirmWithdrawProposition = async (reason: string) => {
    try {
      await withdrawProposition(lead.id, reason, lead.version);
      onOpenChange(false);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Could not withdraw the proposition");
    }
  };

  /**
   * Reopening a won/lost opportunity is a governed transition: the reason is
   * mandatory, the server bumps `reopen_count` and stamps `reopened_at`.
   */
  const confirmReopen = async (reason: string) => {
    try {
      await reopenLead(lead.id, reason, lead.version);
      await refreshLeads();
      onOpenChange(false);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Could not reopen this opportunity");
    }
  };

  const handleReopen = () => {
    if (isReadOnly) {
      openUpgradeModal("crm");
      return;
    }
    setShowReopenDialog(true);
  };

  const handleDelete = () => {
    if (isReadOnly) {
      openUpgradeModal("crm");
      return;
    }
    setShowArchiveDialog(true);
  };

  /** Archiving is reversible and requires a reason the server records. */
  const confirmArchive = async (reason: string) => {
    setIsDeleting(true);
    try {
      await deleteLead(lead.id, reason, lead.version);
      onOpenChange(false);
    } catch (error: any) {
      console.error("Archive failed:", error);
      toast.error(normalizeError(error).message || "Failed to archive lead");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <WorkflowSheet
        open={open}
        onOpenChange={onOpenChange}
        size="2xl"
        title={<span className="text-xl">{lead.name}</span>}
        description={
          <span className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline">{lead.lead_number}</Badge>
            {lead.stage && (
              <Badge
                style={{
                  backgroundColor: lead.stage.color || "#6b7280",
                  color: "white",
                }}
              >
                {lead.stage.name}
              </Badge>
            )}
            {lead.won_at && <Badge className="bg-green-100 text-green-800">Won</Badge>}
            {lead.lost_at && <Badge className="bg-red-100 text-red-800">Lost</Badge>}
          </span>
        }
        headerRight={
          (lead.priority || 0) > 0 ? (
            <div className="flex gap-1">
              {[...Array(lead.priority || 0)].map((_, i) => (
                <Star key={i} className="h-4 w-4 fill-yellow-400 text-yellow-400" />
              ))}
            </div>
          ) : null
        }
        footer={
          <>
            {!isWonOrLost && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleMarkAsWon}
                  disabled={isConverting}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {isConverting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Trophy className="h-4 w-4 mr-2" />
                  )}
                  Mark as Won
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleMarkAsLost}
                  disabled={isConverting}
                  className="text-destructive border-destructive/30 hover:bg-destructive/10"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Mark as Lost
                </Button>
                {isProposition ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowWithdrawDialog(true)}
                    disabled={isConverting}
                  >
                    <Undo2 className="h-4 w-4 mr-2" />
                    Withdraw Proposition
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleMarkAsProposition}
                    disabled={isConverting}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    Mark as Proposition
                  </Button>
                )}
              </>
            )}

            {isWonOrLost && (
              <Button variant="outline" size="sm" onClick={handleReopen} disabled={isConverting}>
                <RotateCcw className="h-4 w-4 mr-2" />
                Reopen
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={isConverting}>
                  {isConverting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Convert To
                  <ChevronDown className="h-4 w-4 ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={handleConvertToContact}>
                  <UserPlus className="h-4 w-4 mr-2" />
                  Create Contact
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleConvertToEstimate}>
                  <FileText className="h-4 w-4 mr-2" />
                  Create Estimate
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleConvertToSalesOrder}>
                  <ShoppingCart className="h-4 w-4 mr-2" />
                  Create Sales Order
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleConvertToProject}>
                  <FolderKanban className="h-4 w-4 mr-2" />
                  Create Project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {hasMultipleBranches && !lead.won_at && !lead.lost_at && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isTransferring}>
                    {isTransferring ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    Transfer Branch
                    <ChevronDown className="h-4 w-4 ml-2" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {branches
                    .filter((b) => b.id !== lead.branch_id)
                    .map((b) => (
                      <DropdownMenuItem key={b.id} onClick={() => handleTransferBranch(b.id)}>
                        {b.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}



            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={isConverting || isDeleting}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              {isDeleting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Delete
            </Button>

            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </>
        }
      >
        <Tabs defaultValue="details" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="details" className="flex items-center gap-2">
              <Info className="h-4 w-4" />
              Details
            </TabsTrigger>
            <TabsTrigger value="activities" className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Activities
              {nextActivity && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                  {activities.filter((a) => !a.is_done).length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="flex items-center gap-2">
              <History className="h-4 w-4" />
              History
            </TabsTrigger>
          </TabsList>


          <TabsContent value="details" className="space-y-6 mt-4">
            {/* Stage assignment. Kanban drag-and-drop cannot reach a lead that
                has no stage yet, so the record itself owns this control. The
                move goes through `crm_change_stage` with the rendered version. */}
            {!isWonOrLost && (
              <PermissionGate permission="manageSales">
                <div className="rounded-lg border bg-muted/30 p-3">
                  {openStages.length === 0 ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-medium">No pipeline stages configured</p>
                        <p className="text-xs text-muted-foreground">
                          Set up your funnel to place this opportunity on the board.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onOpenChange(false);
                          navigate("/crm-app/pipeline");
                        }}
                      >
                        Set up pipeline
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-medium">Pipeline stage</p>
                        <p className="text-xs text-muted-foreground">
                          {lead.stage_id
                            ? "Move this opportunity along the funnel"
                            : "Not on the board yet — pick a stage to place it"}
                        </p>
                      </div>
                      <Select
                        value={lead.stage_id || ""}
                        onValueChange={handleChangeStage}
                        disabled={isMovingStage}
                      >
                        <SelectTrigger className="sm:w-[220px]">
                          <SelectValue placeholder="Select a stage" />
                        </SelectTrigger>
                        <SelectContent>
                          {openStages.map((stage) => (
                            <SelectItem key={stage.id} value={stage.id}>
                              {stage.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </PermissionGate>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {lead.contact_name && (
                <div className="flex items-center gap-2 text-sm">
                  <UserPlus className="h-4 w-4 text-muted-foreground" />
                  <span>{lead.contact_name}</span>
                  {lead.contact_id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-primary"
                      onClick={() => {
                        onOpenChange(false);
                        navigate(`/contacts-app/profile?id=${lead.contact_id}&from=crm`);
                      }}
                    >
                      <ExternalLink className="h-3 w-3 mr-1" />
                      View Profile
                    </Button>
                  )}
                </div>
              )}
              {lead.company_contact?.name && (
                <div className="flex items-center gap-2 text-sm">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <span>{lead.company_contact.name}</span>
                </div>
              )}
              {lead.email && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <a href={`mailto:${lead.email}`} className="text-primary hover:underline">
                    {lead.email}
                  </a>
                </div>
              )}
              {lead.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <a href={`tel:${lead.phone}`} className="text-primary hover:underline">
                    {lead.phone}
                  </a>
                </div>
              )}
            </div>

            <Separator />

            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <CardContent className="p-4">
                  <div className="text-sm text-muted-foreground mb-1">Expected Revenue</div>
                  <div className="text-xl font-bold">
                    {formatCurrency(lead.expected_revenue || 0, lead.currency || baseCurrency)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="text-sm text-muted-foreground mb-1">Probability</div>
                  <div className="text-xl font-bold">{lead.probability || 0}%</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                    <Calendar className="h-4 w-4" />
                    Expected Close
                  </div>
                  <div className="text-xl font-bold">
                    {lead.expected_close_date
                      ? format(new Date(lead.expected_close_date), "MMM d")
                      : "—"}
                  </div>
                </CardContent>
              </Card>
            </div>

            {lead.description && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-2">Description</h4>
                  <p className="text-sm text-muted-foreground">{lead.description}</p>
                </div>
              </>
            )}

            {lead.tags && lead.tags.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {lead.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            <Separator />

            <LeadItemsEditor
              leadId={lead.id}
              organizationId={lead.organization_id}
              businessId={lead.business_id}
              onChanged={refreshLeads}
            />

            {lead.source && (
              <div className="text-xs text-muted-foreground">
                Source: {lead.source}
                {lead.medium && ` / ${lead.medium}`}
                {lead.campaign && ` / ${lead.campaign}`}
              </div>
            )}
          </TabsContent>

          <TabsContent value="activities" className="mt-4">
            <ActivityTimeline
              activities={activities}
              isLoading={activitiesLoading}
              onMarkDone={markAsDone}
              onDelete={deleteActivity}
              onEdit={handleEditActivity}
              onScheduleNew={() => {
                setEditingActivity(undefined);
                setShowActivityDialog(true);
              }}
            />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <LeadHistoryTimeline leadId={lead.id} enabled={open} />
          </TabsContent>
        </Tabs>
      </WorkflowSheet>



      {/* Mark as Won Dialog */}
      <MarkAsWonDialog
        open={showWonDialog}
        onOpenChange={setShowWonDialog}
        lead={lead}
        onConfirm={confirmWon}
      />

      {/* Mark as Lost Dialog */}
      <MarkAsLostDialog
        open={showLostDialog}
        onOpenChange={setShowLostDialog}
        leadName={lead.name}
        onConfirm={confirmLost}
      />

      {/* Schedule Activity Dialog */}
      <ScheduleActivityDialog
        open={showActivityDialog}
        onOpenChange={(open) => {
          setShowActivityDialog(open);
          if (!open) setEditingActivity(undefined);
        }}
        leadId={lead.id}
        leadName={lead.name}
        onSchedule={handleScheduleActivity}
        existingActivity={editingActivity}
      />

      {/* Withdraw Proposition — reason is mandatory server-side */}
      <ReasonDialog
        open={showWithdrawDialog}
        onOpenChange={setShowWithdrawDialog}
        title="Withdraw Proposition"
        description={`Record why the proposition for "${lead.name}" is being withdrawn. The lead returns to its previous qualified state.`}
        confirmLabel="Withdraw Proposition"
        onConfirm={confirmWithdrawProposition}
      />

      {/* Reopen — reason is mandatory server-side */}
      <ReasonDialog
        open={showReopenDialog}
        onOpenChange={setShowReopenDialog}
        title="Reopen opportunity"
        description={`"${lead.name}" returns to the active pipeline. The reason is recorded on the audit trail.`}
        confirmLabel="Reopen"
        onConfirm={confirmReopen}
      />

      {/* Archive — reversible, audited, requires a reason */}
      <ReasonDialog
        open={showArchiveDialog}
        onOpenChange={setShowArchiveDialog}
        title="Archive Lead"
        description={`"${lead.name}" will be removed from the pipeline but kept for audit. Archiving is reversible from the Archived list.`}
        confirmLabel="Archive Lead"
        destructive
        onConfirm={confirmArchive}
      />

    </>
  );
}
