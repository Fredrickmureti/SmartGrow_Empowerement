// @ts-nocheck - Tables not in auto-generated types
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDashboardScope } from "@/hooks/useDashboardScope";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { 
  Activity, 
  FileText, 
  Package, 
  DollarSign, 
  Users, 
  Settings,
  Edit,
  Trash2,
  Plus,
  Eye,
  Send,
  Loader2
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface AuditLogEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_name: string | null;
  entity_id: string | null;
  user_id: string | null;
  created_at: string;
  changes_summary: string | null;
}

const entityIcons: Record<string, typeof FileText> = {
  invoice: FileText,
  product: Package,
  payment: DollarSign,
  contact: Users,
  expense: DollarSign,
  settings: Settings,
};

const actionIcons: Record<string, typeof Plus> = {
  create: Plus,
  update: Edit,
  delete: Trash2,
  view: Eye,
  send: Send,
};

const actionColors: Record<string, string> = {
  create: "bg-green-500/10 text-green-500",
  update: "bg-blue-500/10 text-blue-500",
  delete: "bg-red-500/10 text-red-500",
  view: "bg-gray-500/10 text-gray-500",
  send: "bg-purple-500/10 text-purple-500",
};

function formatActivityMessage(log: AuditLogEntry): string {
  const action = log.action.toLowerCase();
  const entityType = log.entity_type.toLowerCase().replace(/_/g, ' ');
  const entityName = log.entity_name || '';
  
  switch (action) {
    case 'create':
      return `Created ${entityType}${entityName ? `: ${entityName}` : ''}`;
    case 'update':
      return `Updated ${entityType}${entityName ? `: ${entityName}` : ''}`;
    case 'delete':
      return `Deleted ${entityType}${entityName ? `: ${entityName}` : ''}`;
    case 'send':
      return `Sent ${entityType}${entityName ? `: ${entityName}` : ''}`;
    case 'view':
      return `Viewed ${entityType}${entityName ? `: ${entityName}` : ''}`;
    default:
      return `${action} ${entityType}${entityName ? `: ${entityName}` : ''}`;
  }
}

export function ActivityFeed() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useDashboardScope();
  const queryClient = useQueryClient();
  const [isClearing, setIsClearing] = useState(false);

  // Check if user is admin or owner
  const userRole = currentOrg?.role;
  const isAdmin = userRole === "owner" || userRole === "admin" || userRole === "super_admin";

  const { data: activities = [], isLoading } = useQuery({
    // Scope-aware cache key — switching branch / toggling consolidated
    // refetches. audit_logs has no branch_id column today (workspace-
    // wide), so we don't apply a branch filter to the query itself;
    // the key still partitions the cache so stale data from another
    // scope never bleeds across views.
    queryKey: ["activity-feed", currentOrg?.id, currentBusiness?.id, scope.kind, scope.branchId ?? "ALL"],
    queryFn: async () => {
      if (!currentOrg?.id) return [];

      let query = supabase
        // SCOPE-EXEMPT: "audit_logs" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
        .from("audit_logs")
        .select("id, action, entity_type, entity_name, entity_id, user_id, created_at, changes_summary")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false })
        .limit(20);

      // Filter by current business
      query = query.eq("business_id", currentBusiness!.id);
      const { data, error } = await query;
      if (error) throw error;
      return data as AuditLogEntry[];
    },
    enabled: !!currentOrg?.id,
  });

  const handleClearActivity = async () => {
    if (!currentOrg?.id) return;
    
    setIsClearing(true);
    try {
      let deleteQuery = supabase
        .from("audit_logs")
        .delete()
        .eq("organization_id", currentOrg.id);

      deleteQuery = deleteQuery.eq("business_id", currentBusiness!.id);
      const { data, error } = await deleteQuery.select();

      if (error) throw error;

      // Check if any rows were actually deleted
      if (!data || data.length === 0) {
        throw new Error("Deletion was blocked by security policy. You may not have admin permissions.");
      }

      // Invalidate queries to refresh the UI
      queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
      
      toast.success(`Cleared ${data.length} activity log entries`);
    } catch (error: any) {
      console.error("Error clearing activity:", error);
      toast.error(normalizeError(error).message || "Failed to clear activity log");
    } finally {
      setIsClearing(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Recent Activity
            </CardTitle>
            <CardDescription>
              Latest actions in your organization
            </CardDescription>
          </div>
          {isAdmin && activities.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  disabled={isClearing}
                >
                  {isClearing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  <span className="ml-1.5 hidden sm:inline">Clear</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear Activity Log</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete all activity logs for this organization. 
                    This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleClearActivity}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Clear All Activity
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {activities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Activity className="h-10 w-10 mb-2 opacity-50" />
            <p className="text-sm">No recent activity</p>
          </div>
        ) : (
          <ScrollArea className="h-[300px] pr-4">
            <div className="space-y-4">
              {activities.map((activity) => {
                const EntityIcon = entityIcons[activity.entity_type.toLowerCase()] || FileText;
                const ActionIcon = actionIcons[activity.action.toLowerCase()] || Edit;
                const actionColor = actionColors[activity.action.toLowerCase()] || actionColors.update;

                return (
                  <div 
                    key={activity.id} 
                    className="flex items-start gap-3 pb-4 border-b last:border-0 last:pb-0"
                  >
                    {/* Icon */}
                    <div className={`flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${actionColor}`}>
                      <ActionIcon className="h-4 w-4" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">
                        {formatActivityMessage(activity)}
                      </p>
                      {activity.changes_summary && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {activity.changes_summary}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-xs px-1.5 py-0">
                          <EntityIcon className="h-3 w-3 mr-1" />
                          {activity.entity_type.replace(/_/g, ' ')}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(activity.created_at), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
