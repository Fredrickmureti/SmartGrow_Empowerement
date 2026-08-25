// @ts-nocheck
import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { Button } from "@/components/ui/button";
import { Plus, Settings, TrendingUp, Users, Target, Zap, Archive } from "lucide-react";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { useCRMStages, useLeads, Lead } from "@/hooks/crm";
import { LeadCard, NextActivity } from "@/components/crm/LeadCard";
import { LeadForm } from "@/components/crm/LeadForm";
import { LeadDetailsDialog } from "@/components/crm/LeadDetailsDialog";
import { StageSettingsDialog } from "@/components/crm/StageSettingsDialog";
import { ArchivedLeadsDialog } from "@/components/crm/ArchivedLeadsDialog";
import { Badge } from "@/components/ui/badge";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { useCurrency } from "@/hooks/useCurrency";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import { useBranch } from "@/contexts/BranchContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function CRMPipeline() {
  const { stages, isLoading: stagesLoading } = useCRMStages();
  const { branches, hasMultipleBranches } = useBranch();
  // Branch is an ownership dimension of the opportunity, so it filters the
  // query (server side) rather than the rendered board.
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const { leads, isLoading: leadsLoading, moveToStage, markAsWon, deleteLead, refreshLeads } = useLeads(
    useMemo(() => ({ branchId: branchFilter === "all" ? null : branchFilter }), [branchFilter]),
  );

  const [showLeadForm, setShowLeadForm] = useState(false);
  const [showStageSettings, setShowStageSettings] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showLeadDetails, setShowLeadDetails] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [draggedLeadId, setDraggedLeadId] = useState<string | null>(null);
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { currentOrg } = useOrganization();

  // Batch fetch next activities for all leads (fixes N+1)
  const [activitiesMap, setActivitiesMap] = useState<Record<string, NextActivity>>({});
  // Batch fetch assigned user names
  const [userNameMap, setUserNameMap] = useState<Record<string, string>>({});
  
  useEffect(() => {
    async function fetchAllNextActivities() {
      if (!currentOrg?.id || leads.length === 0) return;
      
      const leadIds = leads.map(l => l.id);
      const { data } = await supabase
        .from("crm_activities")
        .select("id, summary, activity_type, due_date, due_time, lead_id")
        .in("lead_id", leadIds)
        .eq("is_done", false)
        .order("due_date", { ascending: true, nullsFirst: false });
      
      if (data) {
        const map: Record<string, NextActivity> = {};
        for (const activity of data) {
          if (!map[activity.lead_id]) {
            map[activity.lead_id] = activity as NextActivity;
          }
        }
        setActivitiesMap(map);
      }
    }
    
    fetchAllNextActivities();
  }, [currentOrg?.id, leads]);

  useEffect(() => {
    async function fetchAssignedUsers() {
      const assignedIds = [...new Set(leads.map(l => l.assigned_to).filter(Boolean))] as string[];
      if (assignedIds.length === 0) return;
      
      const { data } = await supabase
        .from("profiles")
        .select("id, display_name, email")
        .in("id", assignedIds);
      
      if (data) {
        const map: Record<string, string> = {};
        for (const profile of data) {
          map[profile.id] = profile.display_name || profile.email || "Unknown";
        }
        setUserNameMap(map);
      }
    }
    
    fetchAssignedUsers();
  }, [leads]);

  const isLoading = stagesLoading || leadsLoading;

  const getLeadsForStage = (stageId: string) => {
    return leads.filter(lead => lead.stage_id === stageId);
  };

  const getStageValue = (stageId: string) => {
    return getLeadsForStage(stageId).reduce((sum, lead) => sum + (lead.expected_revenue || 0), 0);
  };

  const totalPipelineValue = leads.reduce((sum, lead) => sum + (lead.expected_revenue || 0), 0);
  const weightedPipelineValue = leads.reduce((sum, lead) => 
    sum + ((lead.expected_revenue || 0) * (lead.probability || 0) / 100), 0
  );
  const wonValue = leads.filter(l => l.won_at).reduce((sum, l) => sum + (l.expected_revenue || 0), 0);

  const handleDragStart = (e: React.DragEvent, leadId: string) => {
    setDraggedLeadId(leadId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = async (e: React.DragEvent, stageId: string) => {
    e.preventDefault();
    if (isReadOnly) {
      openUpgradeModal("crm");
      setDraggedLeadId(null);
      return;
    }
    if (draggedLeadId) {
      const targetStage = stages.find(s => s.id === stageId);
      try {
        // Terminal stages are lifecycle transitions, not stage moves: Won has
        // its own authoritative operation and Lost requires a reason, so the
        // board cannot reach them by drag alone.
        if (targetStage?.is_won) {
          await markAsWon(draggedLeadId);
        } else if (targetStage?.is_lost) {
          toast.error("Use \"Mark as Lost\" so a loss reason is recorded");
        } else {
          await moveToStage(draggedLeadId, stageId);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not move this opportunity");
      }
      setDraggedLeadId(null);
    }
  };


  if (isLoading) {
    return <>
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    </>;
  }

  return <>
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="font-bold tracking-tight text-2xl">Sales Pipeline</h1>
          <p className="text-muted-foreground">Track and manage your opportunities</p>
        </div>
        <div className="flex items-center gap-2">
          {hasMultipleBranches && (
            <Select value={branchFilter} onValueChange={setBranchFilter}>
              <SelectTrigger className="w-[180px]">
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
          )}
          <CustomizeFieldsButton entityType="crm_lead" />
          <ReportExportButtons
            compact
            formats={["excel", "csv", "print", "pdf"]}
            getExportConfig={() => {
              const cols: ExportColumn[] = [
                { key: "name", header: "Lead", width: 25 },
                { key: "contact", header: "Contact", width: 20 },
                { key: "company", header: "Company", width: 20 },
                { key: "stage", header: "Stage", width: 15 },
                { key: "revenue", header: "Expected Revenue", format: "currency", width: 18, align: "right" },
                { key: "probability", header: "Probability", format: "percent", width: 12, align: "right" },
                { key: "status", header: "Status", width: 10 },
              ];
              const rows = leads.map((l) => ({
                name: l.name,
                contact: l.contact_name || "",
                company: l.company_contact?.name || "",
                stage: stages.find(s => s.id === l.stage_id)?.name || "",
                revenue: l.expected_revenue || 0,
                probability: l.probability || 0,
                status: l.won_at ? "Won" : l.lost_at ? "Lost" : "Open",
              }));
              return {
                title: "CRM Pipeline Summary",
                companyName: currentOrg?.name,
                columns: cols,
                rows,
                currency: baseCurrency,
                organizationId: currentOrg?.id,
              } as ExportConfig;
            }}
          />
          <Button variant="outline" size="sm" onClick={() => setShowArchived(true)}>
            <Archive className="h-4 w-4 mr-2" />
            Archived
          </Button>
          {/* Pipeline stage administration is a settings-write action server-side
              (`crm_can_admin_pipeline`), so the UI mirrors settings.write. */}
          <PermissionGate
            permissions={["manageBusiness", "manageOrganization", "manageTaxSettings"]}
          >
            <Button variant="outline" size="icon" onClick={() => setShowStageSettings(true)}>
              <Settings className="h-4 w-4" />
            </Button>
          </PermissionGate>
          <PermissionGate permission="manageSales">
            <Button onClick={() => setShowLeadForm(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New Lead
            </Button>
          </PermissionGate>

        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pipeline Value</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalPipelineValue, baseCurrency)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Weighted Value</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(weightedPipelineValue, baseCurrency)}</div>
            <p className="text-xs text-muted-foreground">revenue × probability</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Open Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{leads.filter(l => !l.won_at && !l.lost_at).length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Won</CardTitle>
            <TrendingUp className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(wonValue, baseCurrency)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Kanban Pipeline */}
      {stages.length === 0 ? <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Target className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No pipeline stages configured</h3>
          <p className="text-muted-foreground mb-4">Set up your sales pipeline stages to get started</p>
          <PermissionGate permission="manageSales">
            <Button variant="outline" onClick={() => setShowStageSettings(true)}>
              <Settings className="h-4 w-4 mr-2" />
              Configure Stages
            </Button>
          </PermissionGate>
        </CardContent>
      </Card> : <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map(stage => {
          const stageLeads = getLeadsForStage(stage.id);
          const stageValue = getStageValue(stage.id);
          return <div key={stage.id} className="flex-shrink-0 w-80" onDragOver={handleDragOver} onDrop={e => handleDrop(e, stage.id)}>
            <Card className="h-full">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color || "#6b7280" }} />
                    <CardTitle className="text-sm font-medium">{stage.name}</CardTitle>
                    <Badge variant="secondary" className="text-xs">{stageLeads.length}</Badge>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">{formatCurrency(stageValue, baseCurrency)}</div>
              </CardHeader>
              <CardContent className="space-y-2 min-h-[200px]">
                {stageLeads.map(lead => <div key={lead.id} draggable onDragStart={e => handleDragStart(e, lead.id)} className="cursor-grab active:cursor-grabbing">
                  <LeadCard 
                    lead={lead}
                    nextActivity={activitiesMap[lead.id] || null}
                    assignedUserName={lead.assigned_to ? userNameMap[lead.assigned_to] : null}
                    onClick={() => {
                      setSelectedLead(lead);
                      setShowLeadDetails(true);
                    }} 
                  />
                </div>)}
                {stageLeads.length === 0 && <div className="text-center py-8 text-sm text-muted-foreground border-2 border-dashed rounded-lg">
                  Drop leads here
                </div>}
              </CardContent>
            </Card>
          </div>;
        })}
      </div>}

      <LeadForm open={showLeadForm} onOpenChange={setShowLeadForm} />
      <LeadDetailsDialog 
        lead={selectedLead} 
        open={showLeadDetails} 
        onOpenChange={setShowLeadDetails}
        onDelete={deleteLead}
      />
      <StageSettingsDialog open={showStageSettings} onOpenChange={setShowStageSettings} />
      <ArchivedLeadsDialog
        open={showArchived}
        onOpenChange={setShowArchived}
        onRestored={refreshLeads}
      />
    </div>
  </>;
}