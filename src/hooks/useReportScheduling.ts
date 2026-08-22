import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export interface ScheduledReport {
  id: string;
  organization_id: string;
  template_id: string | null;
  name: string;
  report_type: string;
  schedule_type: "daily" | "weekly" | "monthly" | "quarterly" | "every_1_min" | "every_5_min" | "every_15_min";
  schedule_config: {
    day_of_week?: number;
    day_of_month?: number;
    time_of_day?: string;
  };
  recipients: Array<{ email: string; name?: string }>;
  format: "pdf" | "csv" | "excel";
  include_charts: boolean;
  date_range_type: string;
  filters: Record<string, unknown>;
  /** Branch the delivered report is scoped to. `null` = the whole business. */
  branch_id: string | null;
  is_active: boolean;
  last_sent_at: string | null;
  next_send_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComplianceItem {
  id: string;
  organization_id: string;
  business_id: string | null;
  category: "tax" | "audit" | "regulatory" | "internal";
  title: string;
  description: string | null;
  due_date: string | null;
  frequency: "one_time" | "monthly" | "quarterly" | "annually" | null;
  status: "pending" | "in_progress" | "completed" | "overdue";
  assigned_to: string | null;
  completed_at: string | null;
  completed_by: string | null;
  notes: string | null;
  attachments: Array<{ name: string; url: string }>;
  reminder_days: number;
  last_reminded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportGenerationLog {
  id: string;
  organization_id: string;
  scheduled_report_id: string | null;
  template_id: string | null;
  report_type: string;
  status: "pending" | "generating" | "completed" | "failed";
  generated_by: string | null;
  recipients_sent: Array<{ email: string; sent_at?: string }>;
  file_url: string | null;
  file_size_bytes: number | null;
  parameters: Record<string, unknown>;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

// Calculate next send date based on schedule
function calculateNextSendAt(
  scheduleType: string,
  scheduleConfig: ScheduledReport["schedule_config"]
): string {
  const now = new Date();
  const next = new Date(now);

  switch (scheduleType) {
    case "every_1_min":
      next.setMinutes(next.getMinutes() + 1);
      return next.toISOString();
    case "every_5_min":
      next.setMinutes(next.getMinutes() + 5);
      return next.toISOString();
    case "every_15_min":
      next.setMinutes(next.getMinutes() + 15);
      return next.toISOString();
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      const dayOfWeek = scheduleConfig.day_of_week ?? 1; // Default Monday
      const daysUntilNext = (dayOfWeek - now.getDay() + 7) % 7 || 7;
      next.setDate(next.getDate() + daysUntilNext);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      if (scheduleConfig.day_of_month) {
        next.setDate(Math.min(scheduleConfig.day_of_month, 28));
      }
      break;
    case "quarterly":
      next.setMonth(next.getMonth() + 3);
      break;
  }

  if (scheduleConfig.time_of_day) {
    const [hours, minutes] = scheduleConfig.time_of_day.split(":").map(Number);
    next.setHours(hours, minutes, 0, 0);
  } else {
    next.setHours(8, 0, 0, 0); // Default 8 AM
  }

  return next.toISOString();
}

export function useScheduledReports() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchReports = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("scheduled_reports")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setReports((data || []) as unknown as ScheduledReport[]);
    } catch (error) {
      console.error("Error fetching scheduled reports:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const createReport = async (
    report: Omit<ScheduledReport, "id" | "organization_id" | "created_at" | "updated_at" | "last_sent_at">
  ) => {
    if (!currentOrg) throw new Error("No organization");

    const nextSendAt = calculateNextSendAt(report.schedule_type, report.schedule_config);

    const { data, error } = await supabase
      .from("scheduled_reports")
      .insert({
        ...report,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        next_send_at: nextSendAt,
      } as never)
      .select()
      .single();

    if (error) throw error;
    toast.success("Scheduled report created");
    await fetchReports();
    return data as unknown as ScheduledReport;
  };

  const updateReport = async (id: string, updates: Partial<ScheduledReport>) => {
    const { error } = await supabase
      .from("scheduled_reports")
      .update(updates as never)
      .eq("id", id);

    if (error) throw error;
    toast.success("Scheduled report updated");
    await fetchReports();
  };

  const deleteReport = async (id: string) => {
    const { error } = await supabase
      .from("scheduled_reports")
      .delete()
      .eq("id", id);

    if (error) throw error;
    toast.success("Scheduled report deleted");
    await fetchReports();
  };

  const toggleReport = async (id: string, isActive: boolean) => {
    await updateReport(id, { is_active: isActive });
  };

  return {
    reports,
    isLoading,
    createReport,
    updateReport,
    deleteReport,
    toggleReport,
    refreshReports: fetchReports,
    activeReports: reports.filter((r) => r.is_active),
  };
}

export function useComplianceChecklist() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [items, setItems] = useState<ComplianceItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("compliance_checklist")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("due_date", { ascending: true });

      if (error) throw error;
      setItems((data || []) as unknown as ComplianceItem[]);
    } catch (error) {
      console.error("Error fetching compliance items:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const createItem = async (
    item: Omit<ComplianceItem, "id" | "organization_id" | "created_at" | "updated_at" | "completed_at" | "completed_by" | "last_reminded_at">
  ) => {
    if (!currentOrg) throw new Error("No organization");

    const { data, error } = await supabase
      .from("compliance_checklist")
      .insert({
        ...item,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      } as never)
      .select()
      .single();

    if (error) throw error;
    toast.success("Compliance item created");
    await fetchItems();
    return data as unknown as ComplianceItem;
  };

  const updateItem = async (id: string, updates: Partial<ComplianceItem>) => {
    const { error } = await supabase
      .from("compliance_checklist")
      .update(updates as never)
      .eq("id", id);

    if (error) throw error;
    await fetchItems();
  };

  const completeItem = async (id: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    await updateItem(id, {
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: user?.id,
    });
    toast.success("Item marked as completed");
  };

  const deleteItem = async (id: string) => {
    const { error } = await supabase
      // SCOPE-EXEMPT: `compliance_checklist` is workspace-wide (no business_id column)
      .from("compliance_checklist")
      .delete()
      .eq("id", id);

    if (error) throw error;
    toast.success("Compliance item deleted");
    await fetchItems();
  };

  // Computed stats
  const stats = {
    total: items.length,
    pending: items.filter((i) => i.status === "pending").length,
    inProgress: items.filter((i) => i.status === "in_progress").length,
    completed: items.filter((i) => i.status === "completed").length,
    overdue: items.filter((i) => i.status === "overdue").length,
    dueSoon: items.filter((i) => {
      if (!i.due_date || i.status === "completed") return false;
      const dueDate = new Date(i.due_date);
      const now = new Date();
      const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return daysUntilDue >= 0 && daysUntilDue <= 7;
    }).length,
  };

  return {
    items,
    isLoading,
    createItem,
    updateItem,
    completeItem,
    deleteItem,
    refreshItems: fetchItems,
    stats,
    pendingItems: items.filter((i) => i.status === "pending"),
    overdueItems: items.filter((i) => i.status === "overdue"),
    completedItems: items.filter((i) => i.status === "completed"),
  };
}

export function useReportGenerationLogs() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [logs, setLogs] = useState<ReportGenerationLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchLogs = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("report_generation_logs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      setLogs((data || []) as unknown as ReportGenerationLog[]);
    } catch (error) {
      console.error("Error fetching report logs:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return {
    logs,
    isLoading,
    refreshLogs: fetchLogs,
    recentLogs: logs.slice(0, 10),
  };
}
