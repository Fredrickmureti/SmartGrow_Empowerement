// @ts-nocheck
import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, CalendarCheck, Users, ArrowRight, TrendingUp, Target, AlertCircle, Trophy, Zap, Clock, Archive } from "lucide-react";
import { useLeads, Lead } from "@/hooks/crm/useLeads";
import { useCRMStages } from "@/hooks/crm/useCRMStages";
import { useCRMActivities } from "@/hooks/crm/useCRMActivities";
import { useCurrency } from "@/hooks/useCurrency";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, FunnelChart, Funnel, LabelList, PieChart, Pie, Legend } from "recharts";
import { differenceInDays } from "date-fns";
import { LeadDetailsDialog } from "@/components/crm/LeadDetailsDialog";
import { ArchivedLeadsDialog } from "@/components/crm/ArchivedLeadsDialog";

/**
 * CRM Module Dashboard — Pipeline value, funnel chart, lead stats, activities due, win rate
 */
export default function CRMDashboard() {
  const navigate = useNavigate();
  const { leads, isLoading: leadsLoading, deleteLead } = useLeads();
  const { stages, isLoading: stagesLoading } = useCRMStages();
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [showLeadDetails, setShowLeadDetails] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { activities, isLoading: activitiesLoading } = useCRMActivities();
  const { formatCurrency } = useCurrency();

  const isLoading = leadsLoading || stagesLoading || activitiesLoading;

  // Pipeline value
  const activeLeads = leads.filter(l => l.is_active !== false);
  const totalPipelineValue = activeLeads.reduce((s, l) => s + (l.expected_revenue || 0), 0);
  const weightedPipelineValue = activeLeads.reduce((s, l) => 
    s + ((l.expected_revenue || 0) * (l.probability || 0) / 100), 0
  );
  const wonLeads = leads.filter(l => l.stage?.is_won);
  const lostLeads = leads.filter(l => l.stage?.is_lost);
  const wonRevenue = wonLeads.reduce((s, l) => s + (l.expected_revenue || 0), 0);

  // Win rate
  const closedLeads = wonLeads.length + lostLeads.length;
  const winRate = closedLeads > 0 ? Math.round((wonLeads.length / closedLeads) * 100) : 0;

  // Pipeline velocity (avg days from creation to won)
  const velocity = useMemo(() => {
    const wonWithDates = wonLeads.filter(l => l.won_at && l.created_at);
    if (wonWithDates.length === 0) return 0;
    const totalDays = wonWithDates.reduce((sum, l) => 
      sum + differenceInDays(new Date(l.won_at!), new Date(l.created_at)), 0
    );
    return Math.round(totalDays / wonWithDates.length);
  }, [wonLeads]);

  // Activities due
  const today = new Date().toISOString().split("T")[0];
  const overdue = (activities || []).filter((a: any) => !a.is_done && a.due_date && a.due_date < today);
  const dueToday = (activities || []).filter((a: any) => !a.is_done && a.due_date === today);
  const totalPending = (activities || []).filter((a: any) => !a.is_done);

  // Leads by stage (for funnel)
  const leadsByStage = stages.map(stage => ({
    name: stage.name,
    color: stage.color || "#6b7280",
    count: activeLeads.filter(l => l.stage_id === stage.id).length,
    value: activeLeads.filter(l => l.stage_id === stage.id).reduce((s, l) => s + (l.expected_revenue || 0), 0),
  }));

  // Top opportunities
  const topOpportunities = useMemo(() => 
    activeLeads
      .filter(l => !l.won_at && !l.lost_at && (l.expected_revenue || 0) > 0)
      .sort((a, b) => (b.expected_revenue || 0) - (a.expected_revenue || 0))
      .slice(0, 5),
    [activeLeads]
  );

  // Losses by reason — ERP-standard pipeline-review breakdown.
  // Falls back to "Unspecified" for legacy lost leads with no reason_id set.
  const lossesByReason = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of lostLeads) {
      const key = l.lost_reason?.name || "Unspecified";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [lostLeads]);
  const LOSS_COLORS = ["#ef4444", "#f97316", "#eab308", "#a855f7", "#06b6d4", "#6366f1", "#94a3b8"];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">CRM Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pipeline, leads, and upcoming activities
        </p>
      </div>

      {/* Overdue Activities Alert */}
      {overdue.length > 0 && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-destructive text-base">
              <AlertCircle className="h-5 w-5" />
              {overdue.length} overdue activit{overdue.length !== 1 ? "ies" : "y"} need attention
            </CardTitle>
          </CardHeader>
        </Card>
      )}

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-teal-500" onClick={() => navigate("/crm-app/pipeline")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Pipeline Value</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(totalPipelineValue)}</div>
            <p className="text-xs text-muted-foreground mt-1">{activeLeads.length} active leads</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Weighted Forecast</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(weightedPipelineValue)}</div>
            <p className="text-xs text-muted-foreground mt-1">revenue × probability</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-emerald-500">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Won Revenue</CardTitle>
              <Target className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{formatCurrency(wonRevenue)}</div>
            <p className="text-xs text-muted-foreground mt-1">{wonLeads.length} won · {winRate}% win rate</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-violet-500">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Avg Velocity</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{velocity} days</div>
            <p className="text-xs text-muted-foreground mt-1">creation → won</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-500" onClick={() => navigate("/crm-app/activities")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Activities Due</CardTitle>
              <CalendarCheck className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{totalPending.length}</div>
            <div className="flex gap-1.5 mt-1">
              {overdue.length > 0 && (
                <Badge variant="destructive" className="text-xs">{overdue.length} overdue</Badge>
              )}
              {dueToday.length > 0 && (
                <Badge variant="outline" className="text-xs">{dueToday.length} today</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Pipeline Funnel Chart */}
        {leadsByStage.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pipeline Funnel</CardTitle>
              <CardDescription>Lead distribution across stages</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={leadsByStage} layout="vertical" margin={{ left: 20, right: 20 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 12 }} />
                  <Tooltip 
                    formatter={(value: number, name: string) => [value, "Leads"]}
                    contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))" }}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {leadsByStage.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Top Opportunities */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top Opportunities</CardTitle>
            <CardDescription>Highest value open deals</CardDescription>
          </CardHeader>
          <CardContent>
            {topOpportunities.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No open opportunities</p>
            ) : (
              <div className="space-y-3">
                {topOpportunities.map(lead => (
                  <div
                    key={lead.id}
                    className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                    onClick={() => { setSelectedLead(lead); setShowLeadDetails(true); }}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{lead.name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {lead.stage && (
                          <Badge className="text-xs" style={{ backgroundColor: lead.stage.color || "#6b7280", color: "white" }}>
                            {lead.stage.name}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">{lead.probability || 0}%</span>
                      </div>
                    </div>
                    <span className="text-sm font-bold text-primary ml-2 shrink-0">
                      {formatCurrency(lead.expected_revenue || 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Lead Source Stats */}
      {activeLeads.length > 0 && (() => {
        const sources = [...new Set(activeLeads.map(l => l.source).filter(Boolean))];
        if (sources.length === 0) return null;
        return (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Leads by Source</CardTitle>
              <CardDescription>Where your leads come from</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {sources.map(src => {
                  const count = activeLeads.filter(l => l.source === src).length;
                  return (
                    <Badge key={src} variant="secondary" className="text-xs">
                      {src}: {count}
                    </Badge>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Losses by Reason — enterprise pipeline-review breakdown */}
      {lossesByReason.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Losses by Reason</CardTitle>
            <CardDescription>
              {lostLeads.length} lost lead{lostLeads.length !== 1 ? "s" : ""} grouped by reason
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={lossesByReason}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                  label={(entry: any) => `${entry.name}: ${entry.value}`}
                >
                  {lossesByReason.map((_, idx) => (
                    <Cell key={idx} fill={LOSS_COLORS[idx % LOSS_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number, name: string) => [value, name]}
                  contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))" }}
                />
                <Legend verticalAlign="bottom" height={32} iconSize={10} wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/crm-app/pipeline")}>
              Pipeline <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/crm-app/activities")}>
              Activities <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/crm-app/contacts")}>
              All Contacts <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowArchived(true)}>
              <Archive className="h-3 w-3 mr-1" /> Archived
            </Button>
          </div>
        </CardContent>
      </Card>
      {/* Archived opportunities — restore is audited server-side */}
      <ArchivedLeadsDialog open={showArchived} onOpenChange={setShowArchived} />

      {/* Lead Details Dialog */}
      <LeadDetailsDialog
        lead={selectedLead}
        open={showLeadDetails}
        onOpenChange={setShowLeadDetails}
        onDelete={deleteLead}
      />
    </div>
  );
}
