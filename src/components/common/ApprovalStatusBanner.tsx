/**
 * Approval Status Banner
 * 
 * Shown on entity detail views when a pending approval exists.
 * Approvers see Approve/Reject buttons. Requesters see status.
 */
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useApprovalGate } from "@/hooks/useApprovalGate";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Clock, MessageSquare } from "lucide-react";
import { toast } from "sonner";

interface ApprovalStatusBannerProps {
  entityType: string;
  entityId: string;
  actionName: string;
  onStatusChange?: () => void;
}

interface ApprovalLog {
  id: string;
  status: string;
  requested_by: string | null;
  approved_by: string | null;
  rejected_by: string | null;
  notes: string | null;
  created_at: string;
  rule_id: string;
}

export function ApprovalStatusBanner({
  entityType,
  entityId,
  actionName,
  onStatusChange,
}: ApprovalStatusBannerProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { approveRequest, rejectRequest } = useApprovalGate();
  const [log, setLog] = useState<ApprovalLog | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [rejectNotes, setRejectNotes] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (!currentOrg || !entityId) return;

    const fetchLog = async () => {
      const { data } = await supabase
        .from("approval_rule_logs")
        .select("id, status, requested_by, approved_by, rejected_by, notes, created_at, rule_id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .eq("action_name", actionName)
        .order("created_at", { ascending: false })
        .limit(1);

      if (data && data.length > 0 && data[0].status === "pending") {
        setLog(data[0] as ApprovalLog);
      } else {
        setLog(null);
      }
    };

    fetchLog();
  }, [currentOrg?.id, entityType, entityId, actionName]);

  if (!log) return null;

  const isRequester = log.requested_by === user?.id;

  const handleApprove = async () => {
    setIsProcessing(true);
    const ok = await approveRequest(log.id);
    if (ok) {
      toast.success("Approved successfully");
      setLog(null);
      onStatusChange?.();
    } else {
      toast.error("Failed to approve");
    }
    setIsProcessing(false);
  };

  const handleReject = async () => {
    setIsProcessing(true);
    const ok = await rejectRequest(log.id, rejectNotes || undefined);
    if (ok) {
      toast.success("Rejected");
      setLog(null);
      onStatusChange?.();
    } else {
      toast.error("Failed to reject");
    }
    setIsProcessing(false);
  };

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-4 mb-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Pending Approval
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {actionName.replace(/_/g, " ")} requires approval before proceeding
            </p>
            {log.notes && (
              <p className="text-xs text-muted-foreground mt-1 italic">
                "{log.notes}"
              </p>
            )}
          </div>
        </div>

        {!isRequester && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowNotes(!showNotes)}
              className="gap-1"
            >
              <MessageSquare className="h-3 w-3" />
              Notes
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleReject}
              disabled={isProcessing}
              className="gap-1"
            >
              <XCircle className="h-3 w-3" />
              Reject
            </Button>
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={isProcessing}
              className="gap-1"
            >
              <CheckCircle className="h-3 w-3" />
              Approve
            </Button>
          </div>
        )}

        {isRequester && (
          <Badge variant="outline" className="text-amber-700 border-amber-300">
            Awaiting review
          </Badge>
        )}
      </div>

      {showNotes && !isRequester && (
        <div className="mt-3 flex items-center gap-2">
          <Textarea
            placeholder="Rejection reason..."
            value={rejectNotes}
            onChange={(e) => setRejectNotes(e.target.value)}
            rows={2}
            className="text-sm"
          />
        </div>
      )}
    </div>
  );
}
