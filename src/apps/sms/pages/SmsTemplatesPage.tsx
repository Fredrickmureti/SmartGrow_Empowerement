import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSmsTemplates, type SmsTemplate } from "@/hooks/useSmsTemplates";
import { FileText, Plus, Trash2, Loader2, Send, AlertTriangle } from "lucide-react";
import type { Database } from "@/integrations/supabase/types";
import { SmsCharCounter } from "@/components/sms/SmsCharCounter";
import { SMS_EVENT_VARIABLES, findUnknownVariables, renderTemplatePreview } from "@/lib/sms/eventVariables";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { isValidE164, normalizeE164 } from "@/lib/sms/phone";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

type SmsEventType = Database["public"]["Enums"]["sms_event_type"];

const EVENT_TYPES: { value: SmsEventType; label: string }[] = [
  { value: "invoice_posted", label: "Invoice Posted" },
  { value: "payment_received", label: "Payment Received" },
  { value: "invoice_overdue", label: "Invoice Overdue" },
  { value: "payment_reminder", label: "Payment Reminder" },
  { value: "estimate_sent", label: "Estimate Sent" },
  { value: "sales_order_confirmed", label: "Sales Order Confirmed" },
  { value: "delivery_shipped", label: "Delivery Shipped" },
  { value: "credit_note_issued", label: "Credit Note Issued" },
  { value: "recurring_invoice_generated", label: "Recurring Invoice Generated" },
  { value: "customer_statement_sent", label: "Customer Statement Sent" },
  { value: "po_sent", label: "Purchase Order Sent" },
  { value: "expense_approved", label: "Expense Approved" },
  { value: "expense_rejected", label: "Expense Rejected" },
  { value: "payroll_processed", label: "Payroll Processed" },
  { value: "low_stock_alert", label: "Low Stock Alert" },
  { value: "out_of_stock", label: "Out of Stock" },
];

const VARIABLE_HINTS: Record<SmsEventType, string[]> = {
  invoice_posted: ["customer_name", "invoice_number", "amount", "due_date"],
  payment_received: ["customer_name", "amount", "payment_date", "reference"],
  invoice_overdue: ["customer_name", "invoice_number", "amount", "days_overdue"],
  po_sent: ["vendor_name", "po_number", "amount"],
  estimate_sent: ["customer_name", "estimate_number", "amount", "valid_until"],
  delivery_shipped: ["customer_name", "delivery_number", "tracking_number"],
  payment_reminder: ["customer_name", "invoice_number", "amount", "due_date", "days_until_due"],
  credit_note_issued: ["customer_name", "credit_note_number", "amount"],
  sales_order_confirmed: ["customer_name", "so_number", "amount", "expected_date"],
  recurring_invoice_generated: ["customer_name", "invoice_number", "amount", "due_date"],
  expense_approved: ["employee_name", "expense_ref", "amount"],
  expense_rejected: ["employee_name", "expense_ref", "amount", "reason"],
  payroll_processed: ["employee_name", "period", "net_pay"],
  low_stock_alert: ["product_name", "current_stock", "reorder_level"],
  out_of_stock: ["product_name", "sku"],
  customer_statement_sent: ["customer_name", "period", "total_due", "total_overdue"],
};

const SAMPLE_DATA: Record<SmsEventType, Record<string, string>> = {
  invoice_posted: { customer_name: "John Smith", invoice_number: "INV-001", amount: "1,250.00", due_date: "Mar 15, 2026" },
  payment_received: { customer_name: "Jane Doe", amount: "500.00", payment_date: "Feb 17, 2026", reference: "PAY-042" },
  invoice_overdue: { customer_name: "Acme Corp", invoice_number: "INV-099", amount: "3,400.00", days_overdue: "7" },
  po_sent: { vendor_name: "Supply Co", po_number: "PO-123", amount: "2,100.00" },
  estimate_sent: { customer_name: "John Smith", estimate_number: "EST-010", amount: "5,000.00", valid_until: "Apr 30, 2026" },
  delivery_shipped: { customer_name: "Jane Doe", delivery_number: "DN-045", tracking_number: "TRK123456" },
  payment_reminder: { customer_name: "Acme Corp", invoice_number: "INV-099", amount: "3,400.00", due_date: "Apr 1, 2026", days_until_due: "3" },
  credit_note_issued: { customer_name: "John Smith", credit_note_number: "CN-007", amount: "200.00" },
  sales_order_confirmed: { customer_name: "Jane Doe", so_number: "SO-055", amount: "8,500.00", expected_date: "Apr 10, 2026" },
  recurring_invoice_generated: { customer_name: "Acme Corp", invoice_number: "INV-REC-012", amount: "1,500.00", due_date: "Apr 1, 2026" },
  expense_approved: { employee_name: "John Smith", expense_ref: "EXP-034", amount: "320.00" },
  expense_rejected: { employee_name: "Jane Doe", expense_ref: "EXP-035", amount: "1,200.00", reason: "Missing receipts" },
  payroll_processed: { employee_name: "John Smith", period: "March 2026", net_pay: "4,500.00" },
  low_stock_alert: { product_name: "Widget A", current_stock: "5", reorder_level: "20" },
  out_of_stock: { product_name: "Widget A", sku: "WDG-001" },
  customer_statement_sent: { customer_name: "Acme Corp", period: "Q1 2026", total_due: "12,500.00", total_overdue: "3,400.00" },
};

export default function SmsTemplatesPage() {
  const { templates, isLoading, upsertTemplate, deleteTemplate } = useSmsTemplates();
  const [editing, setEditing] = useState<Partial<SmsTemplate> | null>(null);
  const [testPhone, setTestPhone] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const { currentOrg } = useOrganization();

  const insertVariable = (key: string) => {
    const current = editing?.body_template || "";
    setEditing({ ...editing, body_template: `${current}{{${key}}}` });
  };

  const sendTestSms = async () => {
    if (!editing?.event_type || !editing?.body_template || !currentOrg?.id) return;
    const norm = normalizeE164(testPhone);
    if (!norm || !isValidE164(norm)) {
      toast.error("Enter a phone in international (E.164) format, e.g. +14155552671");
      return;
    }
    setSendingTest(true);
    try {
      const rendered = renderTemplatePreview(editing.event_type, editing.body_template);
      const { data, error } = await supabase.functions.invoke("send-sms", {
        body: {
          organization_id: currentOrg.id,
          recipient_phone: norm,
          custom_message: rendered,
          is_test: true,
          triggered_by: "test",
          template_id: editing.id,
        },
      });
      if (error) throw error;
      if (data?.success) toast.success("Test SMS sent");
      else toast.error(data?.message || data?.error || "Test send failed");
    } catch (e) {
      toast.error(normalizeError(e).message);
    } finally {
      setSendingTest(false);
    }
  };

  const handleSave = () => {
    if (!editing?.event_type || !editing?.name || !editing?.body_template) return;
    upsertTemplate.mutate(
      {
        id: editing.id,
        event_type: editing.event_type as SmsEventType,
        name: editing.name,
        body_template: editing.body_template,
        is_active: editing.is_active ?? true,
      },
      { onSuccess: () => setEditing(null) }
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl px-4 sm:px-0">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">SMS Templates</h2>
          <p className="text-sm text-muted-foreground">Manage message templates for each event type.</p>
        </div>
        <Button onClick={() => setEditing({ is_active: true })} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          New Template
        </Button>
      </div>

      {editing && (
        <Card>
          <CardHeader>
            <CardTitle>{editing.id ? "Edit Template" : "New Template"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={editing.name || ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Template name"
                />
              </div>
              <div className="space-y-2">
                <Label>Event Type</Label>
                <Select
                  value={editing.event_type || undefined}
                  onValueChange={(v) => setEditing({ ...editing, event_type: v as SmsEventType })}
                >
                  <SelectTrigger><SelectValue placeholder="Select event" /></SelectTrigger>
                  <SelectContent>
                    {EVENT_TYPES.map((et) => (
                      <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Message Body</Label>
              <Textarea
                value={editing.body_template || ""}
                onChange={(e) => setEditing({ ...editing, body_template: e.target.value })}
                placeholder="Hi {{customer_name}}, your invoice {{invoice_number}} for {{amount}} has been posted."
                rows={4}
              />
              {editing.event_type && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Click to insert:</p>
                  <div className="flex flex-wrap gap-1">
                    {(SMS_EVENT_VARIABLES[editing.event_type as SmsEventType] || []).map((v) => (
                      <button
                        type="button"
                        key={v.key}
                        onClick={() => insertVariable(v.key)}
                        className="text-xs px-2 py-0.5 rounded border bg-muted hover:bg-accent transition-colors"
                        title={v.label}
                      >
                        {`{{${v.key}}}`}
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const unknown = findUnknownVariables(editing.event_type, editing.body_template || "");
                    if (unknown.length === 0) return null;
                    return (
                      <p className="text-xs text-destructive flex items-center gap-1 mt-1">
                        <AlertTriangle className="h-3 w-3" />
                        Unknown variable{unknown.length > 1 ? "s" : ""}: {unknown.map((u) => `{{${u}}}`).join(", ")}
                      </p>
                    );
                  })()}
                </div>
              )}
              <SmsCharCounter text={editing.body_template || ""} />
              {editing.event_type && editing.body_template && (
                <div className="mt-2 p-3 rounded-md bg-muted/50 border">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Preview with sample data:</p>
                  <p className="text-sm">
                    {editing.body_template.replace(
                      /\{\{(\w+)\}\}/g,
                      (_, key) => SAMPLE_DATA[editing.event_type as SmsEventType]?.[key] ?? `{{${key}}}`
                    )}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={editing.is_active ?? true}
                onCheckedChange={(checked) => setEditing({ ...editing, is_active: checked })}
              />
              <Label>Active</Label>
            </div>

            <div className="border-t pt-3 space-y-2">
              <Label className="text-xs uppercase tracking-wider">Send test SMS</Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder="+14155552671"
                  className="sm:max-w-xs"
                />
                <Button
                  variant="outline"
                  onClick={sendTestSms}
                  disabled={sendingTest || !editing.event_type || !editing.body_template || !testPhone}
                >
                  {sendingTest ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                  Send test
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Test sends are logged with a test flag and excluded from analytics.</p>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={upsertTemplate.isPending}>
                {upsertTemplate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
              <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {templates.length === 0 && !editing && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <FileText className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No templates yet. Create one to get started.</p>
            </CardContent>
          </Card>
        )}
        {templates.map((t) => (
          <Card key={t.id}>
            <CardContent className="py-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {EVENT_TYPES.find((et) => et.value === t.event_type)?.label || t.event_type}
                    </span>
                    {!t.is_active && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">Inactive</span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground font-mono break-all">{t.body_template}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => deleteTemplate.mutate(t.id)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
