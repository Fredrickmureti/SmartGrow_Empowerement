import { useState } from "react";
import type * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSmsEventRules } from "@/hooks/useSmsEventRules";
import { useSmsTemplates } from "@/hooks/useSmsTemplates";
import { Loader2, Zap, Users, Building2, UserCog, UserPlus, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RuleRecipientsSheet } from "@/apps/sms/components/RuleRecipientsSheet";
import { SendSmsDialog } from "@/components/sms/SendSmsDialog";
import type { Database } from "@/integrations/supabase/types";

type SmsEventType = Database["public"]["Enums"]["sms_event_type"];
type SmsRecipientType = Database["public"]["Enums"]["sms_recipient_type"];

interface EventConfig {
  value: SmsEventType;
  label: string;
  description: string;
  defaultRecipient: SmsRecipientType;
  category: string;
}

const EVENT_CATEGORIES: { label: string; icon: React.ElementType; events: EventConfig[] }[] = [
  {
    label: "Sales & Invoicing",
    icon: Users,
    events: [
      { value: "invoice_posted", label: "Invoice Posted", description: "Send SMS when an invoice is confirmed", defaultRecipient: "customer", category: "sales" },
      { value: "payment_received", label: "Payment Received", description: "Send SMS confirmation when payment is recorded", defaultRecipient: "customer", category: "sales" },
      { value: "invoice_overdue", label: "Invoice Overdue", description: "Send SMS reminder for overdue invoices", defaultRecipient: "customer", category: "sales" },
      { value: "payment_reminder", label: "Payment Reminder", description: "Send scheduled reminder before invoice due date", defaultRecipient: "customer", category: "sales" },
      { value: "estimate_sent", label: "Estimate Sent", description: "Send SMS when a quote/estimate is sent to customer", defaultRecipient: "customer", category: "sales" },
      { value: "sales_order_confirmed", label: "Sales Order Confirmed", description: "Send SMS when a sales order is confirmed", defaultRecipient: "customer", category: "sales" },
      { value: "delivery_shipped", label: "Delivery Shipped", description: "Send SMS when a delivery note is created", defaultRecipient: "customer", category: "sales" },
      { value: "credit_note_issued", label: "Credit Note Issued", description: "Send SMS when a credit note is applied", defaultRecipient: "customer", category: "sales" },
      { value: "recurring_invoice_generated", label: "Recurring Invoice Generated", description: "Send SMS when a recurring invoice is auto-generated", defaultRecipient: "customer", category: "sales" },
      { value: "customer_statement_sent", label: "Customer Statement Sent", description: "Send SMS when a customer statement is generated", defaultRecipient: "customer", category: "sales" },
    ],
  },
  {
    label: "Purchasing & Vendors",
    icon: Building2,
    events: [
      { value: "po_sent", label: "Purchase Order Sent", description: "Send SMS to vendor when PO is confirmed", defaultRecipient: "vendor", category: "purchasing" },
    ],
  },
  {
    label: "HR & Internal",
    icon: UserCog,
    events: [
      { value: "expense_approved", label: "Expense Approved", description: "Send SMS when an expense claim is approved", defaultRecipient: "employee", category: "hr" },
      { value: "expense_rejected", label: "Expense Rejected", description: "Send SMS when an expense claim is rejected", defaultRecipient: "employee", category: "hr" },
      { value: "payroll_processed", label: "Payroll Processed", description: "Send SMS when payslip is ready", defaultRecipient: "employee", category: "hr" },
      { value: "low_stock_alert", label: "Low Stock Alert", description: "Send SMS when inventory falls below reorder level", defaultRecipient: "internal", category: "hr" },
      { value: "out_of_stock", label: "Out of Stock", description: "Send SMS when a product reaches zero stock", defaultRecipient: "internal", category: "hr" },
    ],
  },
];

const RECIPIENT_LABELS: Record<string, string> = {
  customer: "Customer",
  vendor: "Vendor",
  employee: "Employee",
  internal: "Internal Team",
};

export default function SmsEventRulesPage() {
  const { rules, isLoading, upsertRule } = useSmsEventRules();
  const { templates } = useSmsTemplates();
  const [recipientsFor, setRecipientsFor] = useState<{ ruleId: string; label: string } | null>(null);
  const [testFor, setTestFor] = useState<{ event: SmsEventType; label: string; templateBody: string } | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl px-4 sm:px-0">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Event Rules</h2>
        <p className="text-sm text-muted-foreground">Configure which business events trigger SMS notifications.</p>
      </div>

      {EVENT_CATEGORIES.map((category) => {
        const CategoryIcon = category.icon;
        return (
          <div key={category.label} className="space-y-3">
            <div className="flex items-center gap-2">
              <CategoryIcon className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">{category.label}</h3>
            </div>

            {category.events.map((et) => {
              const rule = rules.find((r) => r.event_type === et.value);
              const isEnabled = rule?.is_enabled ?? false;
              const templateId = rule?.template_id ?? "";
              const eventTemplates = templates.filter((t) => t.event_type === et.value && t.is_active);

              return (
                <Card key={et.value}>
                  <CardContent className="py-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1 flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Zap className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="font-medium">{et.label}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {RECIPIENT_LABELS[et.defaultRecipient] || et.defaultRecipient}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">{et.description}</p>
                      </div>
                      <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
                        {rule?.id && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRecipientsFor({ ruleId: rule.id, label: et.label })}
                          >
                            <UserPlus className="h-4 w-4 mr-1" />
                            Recipients
                          </Button>
                        )}
                        {rule && (
                          <Select
                            value={templateId || undefined}
                            onValueChange={(v) =>
                              upsertRule.mutate({
                                event_type: et.value,
                                is_enabled: isEnabled,
                                template_id: v || null,
                                recipient_type: et.defaultRecipient,
                              })
                            }
                          >
                            <SelectTrigger className="w-full sm:w-48">
                              <SelectValue placeholder="Select template" />
                            </SelectTrigger>
                            <SelectContent>
                              {eventTemplates.map((t) => (
                                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                              ))}
                              {eventTemplates.length === 0 && (
                                <p className="px-2 py-1.5 text-sm text-muted-foreground">No templates for this event</p>
                              )}
                            </SelectContent>
                          </Select>
                        )}
                        {rule?.id && isEnabled && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Send a test SMS using this rule's template to verify the path end-to-end"
                            onClick={() => {
                              const tpl = templates.find((t) => t.id === rule.template_id);
                              setTestFor({
                                event: et.value,
                                label: et.label,
                                templateBody: tpl?.body_template ?? "",
                              });
                            }}
                          >
                            <FlaskConical className="h-4 w-4 mr-1" />
                            Send test
                          </Button>
                        )}
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={(checked) =>
                            upsertRule.mutate({
                              event_type: et.value,
                              is_enabled: checked,
                              recipient_type: et.defaultRecipient,
                            })
                          }
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        );
      })}
      <RuleRecipientsSheet
        open={!!recipientsFor}
        onOpenChange={(v) => { if (!v) setRecipientsFor(null); }}
        ruleId={recipientsFor?.ruleId ?? null}
        eventLabel={recipientsFor?.label ?? ""}
      />
      <SendSmsDialog
        open={!!testFor}
        onOpenChange={(v) => { if (!v) setTestFor(null); }}
        recipientName={testFor ? `Test: ${testFor.label}` : undefined}
        variables={{}}
        context={testFor ? { entityType: "sms_rule_test", entityId: testFor.event } : undefined}
      />
    </div>
  );
}
