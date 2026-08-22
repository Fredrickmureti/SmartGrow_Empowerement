import { useState, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus,
  Calendar,
  Clock,
  Mail,
  FileText,
  MoreHorizontal,
  Play,
  Pause,
  Pencil,
  Trash2,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  History,
  CalendarClock,
  BarChart3,
  FileSpreadsheet,
  Receipt,
  TrendingUp,
  Users,
  Package,
  RefreshCw,
  Send,
  BookOpen,
  Scale,
  ScrollText,
  Target,
  Building2,
  Shield,
  CreditCard,
  DollarSign,
} from "lucide-react";
import {
  useScheduledReports,
  useReportGenerationLogs,
  ScheduledReport,
} from "@/hooks/useReportScheduling";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Report types configuration
const REPORT_TYPES = [
  { value: "balance_sheet", label: "Balance Sheet", icon: FileSpreadsheet, category: "Financial" },
  { value: "income_statement", label: "Income Statement", icon: TrendingUp, category: "Financial" },
  { value: "profit_and_loss", label: "Profit & Loss", icon: DollarSign, category: "Financial" },
  { value: "cash_flow", label: "Cash Flow Statement", icon: BarChart3, category: "Financial" },
  { value: "trial_balance", label: "Trial Balance", icon: Scale, category: "Financial" },
  { value: "general_ledger", label: "General Ledger", icon: BookOpen, category: "Financial" },
  { value: "partner_ledger", label: "Partner Ledger", icon: Users, category: "Financial" },
  { value: "journal_report", label: "Journal Report", icon: ScrollText, category: "Financial" },
  { value: "budget_vs_actual", label: "Budget vs Actual", icon: Target, category: "Financial" },
  { value: "depreciation_schedule", label: "Depreciation Schedule", icon: Building2, category: "Financial" },
  { value: "audit_trail", label: "Audit Trail", icon: Shield, category: "Financial" },
  { value: "sales_summary", label: "Sales Summary", icon: Receipt, category: "Sales" },
  { value: "invoice_aging", label: "Invoice Aging", icon: Calendar, category: "Sales" },
  { value: "aged_payables", label: "Aged Payables", icon: CreditCard, category: "Purchases" },
  { value: "customer_analysis", label: "Customer Analysis", icon: Users, category: "Sales" },
  { value: "expense_report", label: "Expense Report", icon: Receipt, category: "Purchases" },
  { value: "purchase_orders_report", label: "Purchase Orders", icon: Package, category: "Purchases" },
  { value: "crm_pipeline_report", label: "CRM Pipeline Summary", icon: Target, category: "CRM" },
  { value: "contacts_directory", label: "Contacts Directory", icon: Users, category: "Contacts" },
  { value: "stock_report", label: "Stock Report", icon: Package, category: "Operations" },
  { value: "tax_report", label: "Tax Report", icon: FileText, category: "Operations" },
  { value: "management_report", label: "Management Report", icon: BarChart3, category: "Financial" },
  { value: "payroll_summary", label: "Payroll Summary", icon: DollarSign, category: "HR" },
  { value: "leave_report", label: "Leave / Absence Report", icon: Calendar, category: "HR" },
  { value: "attendance_report", label: "Attendance Report", icon: Clock, category: "HR" },
  { value: "pos_sales_report", label: "POS Sales Report", icon: Receipt, category: "POS" },
  { value: "delivery_notes_report", label: "Delivery Notes Report", icon: Package, category: "Sales" },
  { value: "recurring_invoices_report", label: "Recurring Invoices Report", icon: RefreshCw, category: "Sales" },
];

const SCHEDULE_TYPES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "every_1_min", label: "Every 1 Minute (Test)" },
  { value: "every_5_min", label: "Every 5 Minutes (Test)" },
  { value: "every_15_min", label: "Every 15 Minutes (Test)" },
];

const DATE_RANGE_TYPES = [
  { value: "last_7_days", label: "Last 7 Days" },
  { value: "last_30_days", label: "Last 30 Days" },
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "this_quarter", label: "This Quarter" },
  { value: "last_quarter", label: "Last Quarter" },
  { value: "this_year", label: "This Year" },
  { value: "last_year", label: "Last Year" },
];

const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const scheduleFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  report_type: z.string().min(1, "Report type is required"),
  schedule_type: z.enum(["daily", "weekly", "monthly", "quarterly", "every_1_min", "every_5_min", "every_15_min"]),
  day_of_week: z.number().optional(),
  day_of_month: z.number().min(1).max(28).optional(),
  time_of_day: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, "Invalid time format"),
  format: z.enum(["pdf", "csv", "excel"]),
  include_charts: z.boolean(),
  date_range_type: z.string().min(1, "Date range is required"),
  recipients: z.string().min(1, "At least one recipient is required"),
  // "" means the whole business — the same unscoped run the screens show
  // when no branch is selected.
  branch_id: z.string(),
});

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

export function ScheduledReportsManager() {
  const {
    reports,
    isLoading,
    createReport,
    updateReport,
    deleteReport,
    toggleReport,
    refreshReports,
  } = useScheduledReports();
  const { logs, isLoading: logsLoading, refreshLogs } = useReportGenerationLogs();

  const [activeTab, setActiveTab] = useState("schedules");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingReport, setEditingReport] = useState<ScheduledReport | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [reportToDelete, setReportToDelete] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sendingReportId, setSendingReportId] = useState<string | null>(null);

  const handleSendNow = useCallback(async (reportId: string) => {
    setSendingReportId(reportId);
    try {
      const { data, error } = await supabase.functions.invoke("process-scheduled-reports", {
        body: { reportId },
      });
      if (error) throw error;
      toast.success(`Report sent! ${data?.successCount || 0} delivered successfully.`);
      refreshReports();
      refreshLogs();
    } catch (error) {
      console.error("Send Now failed:", error);
      toast.error("Failed to send report. Check logs for details.");
    } finally {
      setSendingReportId(null);
    }
  }, [refreshReports, refreshLogs]);

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      name: "",
      report_type: "",
      schedule_type: "weekly",
      day_of_week: 1,
      day_of_month: 1,
      time_of_day: "08:00",
      format: "pdf",
      include_charts: true,
      date_range_type: "last_month",
      recipients: "",
      branch_id: "",
    },
  });

  const scheduleType = form.watch("schedule_type");

  const handleOpenCreate = () => {
    setEditingReport(null);
    form.reset({
      name: "",
      report_type: "",
      schedule_type: "weekly",
      day_of_week: 1,
      day_of_month: 1,
      time_of_day: "08:00",
      format: "pdf",
      include_charts: true,
      date_range_type: "last_month",
      recipients: "",
      branch_id: "",
    });
    setDialogOpen(true);
  };

  const handleOpenEdit = (report: ScheduledReport) => {
    setEditingReport(report);
    form.reset({
      name: report.name,
      report_type: report.report_type,
      schedule_type: report.schedule_type,
      day_of_week: report.schedule_config.day_of_week ?? 1,
      day_of_month: report.schedule_config.day_of_month ?? 1,
      time_of_day: report.schedule_config.time_of_day ?? "08:00",
      format: report.format,
      include_charts: report.include_charts,
      date_range_type: report.date_range_type,
      recipients: report.recipients.map((r) => r.email).join(", "),
    });
    setDialogOpen(true);
  };

  const handleSubmit = async (values: ScheduleFormValues) => {
    setIsSubmitting(true);
    try {
      const scheduleConfig: ScheduledReport["schedule_config"] = {
        time_of_day: values.time_of_day,
      };

      if (values.schedule_type === "weekly") {
        scheduleConfig.day_of_week = values.day_of_week;
      } else if (values.schedule_type === "monthly" || values.schedule_type === "quarterly") {
        scheduleConfig.day_of_month = values.day_of_month;
      }

      const recipients = values.recipients
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean)
        .map((email) => ({ email }));

      const reportData = {
        name: values.name,
        report_type: values.report_type,
        schedule_type: values.schedule_type,
        schedule_config: scheduleConfig,
        format: values.format,
        include_charts: values.include_charts,
        date_range_type: values.date_range_type,
        recipients,
        filters: {},
        is_active: true,
        template_id: null,
        next_send_at: null,
        created_by: null,
      };

      if (editingReport) {
        await updateReport(editingReport.id, reportData);
      } else {
        await createReport(reportData);
      }

      setDialogOpen(false);
      form.reset();
    } catch (error) {
      console.error("Failed to save schedule:", error);
      toast.error("Failed to save schedule");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!reportToDelete) return;
    try {
      await deleteReport(reportToDelete);
      setDeleteDialogOpen(false);
      setReportToDelete(null);
    } catch (error) {
      console.error("Failed to delete schedule:", error);
      toast.error("Failed to delete schedule");
    }
  };

  const handleToggle = async (id: string, isActive: boolean) => {
    try {
      await toggleReport(id, isActive);
    } catch (error) {
      console.error("Failed to toggle schedule:", error);
      toast.error("Failed to toggle schedule");
    }
  };

  const getReportTypeLabel = (type: string) => {
    return REPORT_TYPES.find((r) => r.value === type)?.label ?? type;
  };

  const getScheduleLabel = (report: ScheduledReport) => {
    const time = report.schedule_config.time_of_day || "08:00";
    switch (report.schedule_type) {
      case "every_1_min":
        return "Every 1 minute (Test)";
      case "every_5_min":
        return "Every 5 minutes (Test)";
      case "every_15_min":
        return "Every 15 minutes (Test)";
      case "daily":
        return `Daily at ${time}`;
      case "weekly":
        const day = DAYS_OF_WEEK.find((d) => d.value === report.schedule_config.day_of_week)?.label || "Monday";
        return `Every ${day} at ${time}`;
      case "monthly":
        const dayNum = report.schedule_config.day_of_month || 1;
        return `Monthly on the ${dayNum}${getOrdinalSuffix(dayNum)} at ${time}`;
      case "quarterly":
        return `Quarterly at ${time}`;
      default:
        return report.schedule_type;
    }
  };

  const getOrdinalSuffix = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  };

  const stats = {
    total: reports.length,
    active: reports.filter((r) => r.is_active).length,
    sentThisMonth: logs.filter((l) => {
      const logDate = new Date(l.created_at);
      const now = new Date();
      return logDate.getMonth() === now.getMonth() && logDate.getFullYear() === now.getFullYear() && l.status === "completed";
    }).length,
    failedThisMonth: logs.filter((l) => {
      const logDate = new Date(l.created_at);
      const now = new Date();
      return logDate.getMonth() === now.getMonth() && logDate.getFullYear() === now.getFullYear() && l.status === "failed";
    }).length,
  };

  return (
    <div className="space-y-6">

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Schedules</CardTitle>
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Play className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.active}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Sent This Month</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.sentThisMonth}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed This Month</CardTitle>
            <XCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.failedThisMonth}</div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <TabsList>
            <TabsTrigger value="schedules" className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4" />
              Schedules
            </TabsTrigger>
            <TabsTrigger value="history" className="flex items-center gap-2">
              <History className="h-4 w-4" />
              History
            </TabsTrigger>
          </TabsList>
          <div className="grid grid-cols-1 sm:flex sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
            <Button variant="outline" size="sm" onClick={activeTab === "schedules" ? refreshReports : refreshLogs} className="w-full sm:w-auto">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button onClick={handleOpenCreate} className="w-full sm:w-auto">
              <Plus className="h-4 w-4 mr-2" />
              New Schedule
            </Button>
          </div>
        </div>

        <TabsContent value="schedules" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Scheduled Reports</CardTitle>
              <CardDescription>
                Automatically generate and email reports on a schedule
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : reports.length === 0 ? (
                <div className="text-center py-12">
                  <CalendarClock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-medium mb-2">No scheduled reports</h3>
                  <p className="text-muted-foreground mb-4">
                    Create your first scheduled report to automate report delivery
                  </p>
                  <Button onClick={handleOpenCreate}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Schedule
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Report Type</TableHead>
                      <TableHead>Schedule</TableHead>
                      <TableHead>Recipients</TableHead>
                      <TableHead>Next Send</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reports.map((report) => (
                      <TableRow key={report.id}>
                        <TableCell className="font-medium">{report.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{getReportTypeLabel(report.report_type)}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-muted-foreground" />
                            {getScheduleLabel(report)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Mail className="h-4 w-4 text-muted-foreground" />
                            <span>{report.recipients.length}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {report.next_send_at ? (
                            format(new Date(report.next_send_at), "MMM d, yyyy HH:mm")
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={report.is_active}
                            onCheckedChange={(checked) => handleToggle(report.id, checked)}
                          />
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleOpenEdit(report)}>
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleSendNow(report.id)} disabled={sendingReportId === report.id}>
                                <Send className="h-4 w-4 mr-2" />
                                {sendingReportId === report.id ? "Sending..." : "Send Now"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => {
                                  setReportToDelete(report.id);
                                  setDeleteDialogOpen(true);
                                }}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Generation History</CardTitle>
              <CardDescription>View past report generations and their status</CardDescription>
            </CardHeader>
            <CardContent>
              {logsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : logs.length === 0 ? (
                <div className="text-center py-12">
                  <History className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-medium mb-2">No generation history</h3>
                  <p className="text-muted-foreground">
                    Report generation logs will appear here
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Report Type</TableHead>
                      <TableHead>Generated At</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Recipients</TableHead>
                      <TableHead>File Size</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>
                          <Badge variant="outline">{getReportTypeLabel(log.report_type)}</Badge>
                        </TableCell>
                        <TableCell>
                          {format(new Date(log.created_at), "MMM d, yyyy HH:mm")}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              log.status === "completed"
                                ? "default"
                                : log.status === "failed"
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {log.status === "completed" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                            {log.status === "failed" && <XCircle className="h-3 w-3 mr-1" />}
                            {log.status === "generating" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                            {log.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{log.recipients_sent?.length || 0}</TableCell>
                        <TableCell>
                          {log.file_size_bytes
                            ? `${(log.file_size_bytes / 1024).toFixed(1)} KB`
                            : "—"}
                        </TableCell>
                        <TableCell>
                          {log.file_url && (
                            <Button variant="ghost" size="sm" asChild>
                              <a href={log.file_url} target="_blank" rel="noopener noreferrer">
                                <Download className="h-4 w-4" />
                              </a>
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingReport ? "Edit Scheduled Report" : "Create Scheduled Report"}
            </DialogTitle>
            <DialogDescription>
              Configure automatic report generation and delivery
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Schedule Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Weekly Sales Report" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="report_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Report Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select report type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {["Financial", "Sales", "Operations"].map((category) => (
                            <div key={category}>
                              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                                {category}
                              </div>
                              {REPORT_TYPES.filter((r) => r.category === category).map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                  <div className="flex items-center gap-2">
                                    <type.icon className="h-4 w-4" />
                                    {type.label}
                                  </div>
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="format"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Format</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="pdf">PDF</SelectItem>
                          <SelectItem value="csv">CSV</SelectItem>
                          <SelectItem value="excel">Excel</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="schedule_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Frequency</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {SCHEDULE_TYPES.map((type) => (
                            <SelectItem key={type.value} value={type.value}>
                              {type.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="date_range_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date Range</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {DATE_RANGE_TYPES.map((type) => (
                            <SelectItem key={type.value} value={type.value}>
                              {type.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {scheduleType === "weekly" && (
                  <FormField
                    control={form.control}
                    name="day_of_week"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Day of Week</FormLabel>
                        <Select
                          onValueChange={(v) => field.onChange(parseInt(v))}
                          value={field.value?.toString()}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {DAYS_OF_WEEK.map((day) => (
                              <SelectItem key={day.value} value={day.value.toString()}>
                                {day.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {(scheduleType === "monthly" || scheduleType === "quarterly") && (
                  <FormField
                    control={form.control}
                    name="day_of_month"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Day of Month</FormLabel>
                        <Select
                          onValueChange={(v) => field.onChange(parseInt(v))}
                          value={field.value?.toString()}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                              <SelectItem key={day} value={day.toString()}>
                                {day}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormDescription>Max day 28 to ensure all months work</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="time_of_day"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Time</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="recipients"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Recipients</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="email1@example.com, email2@example.com"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Comma-separated list of email addresses
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="include_charts"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Include Charts</FormLabel>
                      <FormDescription>
                        Add visual charts to PDF reports
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {editingReport ? "Update Schedule" : "Create Schedule"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Scheduled Report?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this schedule. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
