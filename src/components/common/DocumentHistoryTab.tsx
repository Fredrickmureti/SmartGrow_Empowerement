// @ts-nocheck - Tables not in auto-generated types
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { 
  FileText, 
  Send, 
  Eye, 
  CreditCard, 
  Edit, 
  Trash2, 
  RefreshCw,
  Check,
  X,
  Clock,
  User
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface AuditLogEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  changes_summary: string | null;
  created_at: string;
  user_id: string | null;
}

interface DocumentHistoryTabProps {
  entityType: string;
  entityId: string;
}

const actionIcons: Record<string, React.ElementType> = {
  created: FileText,
  updated: Edit,
  deleted: Trash2,
  sent: Send,
  viewed: Eye,
  paid: CreditCard,
  partial_paid: CreditCard,
  converted: RefreshCw,
  approved: Check,
  rejected: X,
  cancelled: X,
  voided: X,
};

const actionColors: Record<string, string> = {
  created: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  updated: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  deleted: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  sent: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  viewed: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
  paid: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  partial_paid: "bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400",
  converted: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
  cancelled: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
  voided: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
};

export function DocumentHistoryTab({ entityType, entityId }: DocumentHistoryTabProps) {
  const [history, setHistory] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  useEffect(() => {
    const fetchHistory = async () => {
      setIsLoading(true);
      try {
        const { data, error } = await supabase
          .from("audit_logs")
          .select("*")
          .eq("entity_type", entityType)
          .eq("entity_id", entityId)
          .order("created_at", { ascending: false });

        if (error) throw error;
        setHistory(data || []);

        // Fetch user names for user_ids
        const userIds = [...new Set((data || []).map((h) => h.user_id).filter(Boolean))];
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, full_name, email")
            .in("user_id", userIds);

          if (profiles) {
            const names: Record<string, string> = {};
            profiles.forEach((p) => {
              names[p.user_id] = p.full_name || p.email || "Unknown";
            });
            setUserNames(names);
          }
        }
      } catch (err) {
        console.error("Error fetching document history:", err);
      } finally {
        setIsLoading(false);
      }
    };

    if (entityId) {
      fetchHistory();
    }
  }, [entityType, entityId]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Clock className="h-12 w-12 text-muted-foreground/50 mb-3" />
        <p className="text-muted-foreground">No history available</p>
        <p className="text-xs text-muted-foreground/70">
          Actions on this document will appear here
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[300px]">
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />

        <div className="space-y-4 p-4">
          {history.map((entry, index) => {
            const Icon = actionIcons[entry.action] || FileText;
            const colorClass = actionColors[entry.action] || actionColors.created;

            return (
              <div key={entry.id} className="relative flex gap-3 pl-4">
                {/* Timeline dot */}
                <div className={`absolute left-0 -translate-x-1/2 h-8 w-8 rounded-full flex items-center justify-center ${colorClass}`}>
                  <Icon className="h-4 w-4" />
                </div>

                <div className="flex-1 ml-6">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="capitalize text-xs">
                      {entry.action.replace("_", " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(entry.created_at), "MMM d, yyyy 'at' h:mm a")}
                    </span>
                  </div>
                  
                  {entry.changes_summary && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {entry.changes_summary}
                    </p>
                  )}

                  {entry.user_id && (
                    <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      <span>{userNames[entry.user_id] || "Unknown user"}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}
