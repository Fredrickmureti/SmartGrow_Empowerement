import { 
  Mail, 
  Bell, 
  FileText, 
  Clock, 
  AlertTriangle, 
  CheckCircle, 
  ShoppingCart, 
  Package,
  CreditCard,
  UserPlus,
  TrendingUp,
  type LucideIcon
} from "lucide-react";

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: "sales" | "purchasing" | "crm" | "inventory" | "accounting" | "hr";
  icon: LucideIcon;
  triggerType: string;
  targetModel: string;
  triggerConditions?: Record<string, any>;
  steps: Array<{
    actionType: string;
    stepName: string;
    actionConfig: Record<string, any>;
  }>;
  isPopular?: boolean;
}

export const automationTemplates: AutomationTemplate[] = [
  // === SALES AUTOMATIONS ===
  {
    id: "invoice-paid-thank-you",
    name: "Send Thank You on Payment",
    description: "Automatically send a thank you email when an invoice is marked as paid",
    category: "sales",
    icon: Mail,
    triggerType: "field_change",
    targetModel: "invoices",
    triggerConditions: { field: "status", value: "paid" },
    steps: [
      {
        actionType: "send_email",
        stepName: "Send Thank You Email",
        actionConfig: {
          template: "payment_thank_you",
          to: "{{contact.email}}",
          subject: "Thank you for your payment - {{invoice_number}}",
        },
      },
      {
        actionType: "create_activity",
        stepName: "Log Payment Activity",
        actionConfig: {
          activity_type: "payment_received",
          note: "Payment received for invoice {{invoice_number}}",
        },
      },
    ],
    isPopular: true,
  },
  {
    id: "overdue-invoice-reminder",
    name: "Overdue Invoice Reminder",
    description: "Send automated reminders when invoices become overdue",
    category: "sales",
    icon: AlertTriangle,
    triggerType: "due_date_passed",
    targetModel: "invoices",
    triggerConditions: { field: "due_date", status: ["sent", "viewed", "partial"] },
    steps: [
      {
        actionType: "update_record",
        stepName: "Mark as Overdue",
        actionConfig: {
          status: "overdue",
        },
      },
      {
        actionType: "send_email",
        stepName: "Send Reminder Email",
        actionConfig: {
          template: "overdue_reminder",
          to: "{{contact.email}}",
          subject: "Payment Reminder - Invoice {{invoice_number}} is overdue",
        },
      },
      {
        actionType: "send_notification",
        stepName: "Notify Sales Team",
        actionConfig: {
          title: "Invoice Overdue",
          message: "Invoice {{invoice_number}} for {{contact.name}} is now overdue",
          notify_roles: ["sales_manager"],
        },
      },
    ],
    isPopular: true,
  },

  // === CRM AUTOMATIONS ===
  {
    id: "lead-won-create-contact",
    name: "Create Contact on Lead Won",
    description: "Automatically create a contact when a lead is marked as won",
    category: "crm",
    icon: UserPlus,
    triggerType: "field_change",
    targetModel: "crm_leads",
    triggerConditions: { field: "won_at", not_null: true },
    steps: [
      {
        actionType: "convert_document",
        stepName: "Create Contact",
        actionConfig: {
          target_type: "contact",
          field_mapping: {
            name: "{{contact_name}}",
            email: "{{email}}",
            phone: "{{phone}}",
            company: "{{company_name}}",
          },
        },
      },
      {
        actionType: "create_activity",
        stepName: "Log Win",
        actionConfig: {
          activity_type: "deal_won",
          note: "Lead {{name}} was won with value {{expected_revenue}}",
        },
      },
    ],
    isPopular: true,
  },
  {
    id: "lead-stage-notification",
    name: "Notify on Stage Change",
    description: "Send notifications when leads move to key pipeline stages",
    category: "crm",
    icon: Bell,
    triggerType: "field_change",
    targetModel: "crm_leads",
    triggerConditions: { field: "stage_id" },
    steps: [
      {
        actionType: "send_notification",
        stepName: "Notify Assigned User",
        actionConfig: {
          title: "Lead Stage Updated",
          message: "Lead {{name}} moved to {{stage.name}}",
          notify_user: "{{assigned_to}}",
        },
      },
    ],
  },
  {
    id: "high-value-lead-alert",
    name: "High-Value Lead Alert",
    description: "Alert sales managers when a high-value lead is created",
    category: "crm",
    icon: TrendingUp,
    triggerType: "on_create",
    targetModel: "crm_leads",
    triggerConditions: { field: "expected_revenue", operator: ">", value: 50000 },
    steps: [
      {
        actionType: "send_notification",
        stepName: "Alert Sales Manager",
        actionConfig: {
          title: "High-Value Lead Created",
          message: "New lead {{name}} with potential value {{expected_revenue}}",
          notify_roles: ["sales_manager"],
          priority: "high",
        },
      },
      {
        actionType: "add_tag",
        stepName: "Tag as High Value",
        actionConfig: {
          tag: "high-value",
        },
      },
    ],
  },

  // === INVENTORY AUTOMATIONS ===
  {
    id: "low-stock-alert",
    name: "Low Stock Alert",
    description: "Send alerts when product stock falls below reorder level",
    category: "inventory",
    icon: AlertTriangle,
    triggerType: "field_change",
    targetModel: "products",
    triggerConditions: { 
      field: "current_stock",
      compare_to_field: "reorder_level",
      operator: "<="
    },
    steps: [
      {
        actionType: "send_notification",
        stepName: "Alert Inventory Manager",
        actionConfig: {
          title: "Low Stock Alert",
          message: "{{name}} ({{sku}}) stock is low: {{current_stock}} remaining",
          notify_roles: ["inventory_manager", "purchasing"],
          priority: "high",
        },
      },
      {
        actionType: "add_tag",
        stepName: "Tag for Reorder",
        actionConfig: {
          tag: "needs-reorder",
        },
      },
    ],
    isPopular: true,
  },
  {
    id: "auto-reorder",
    name: "Auto-Create Purchase Order",
    description: "Automatically create purchase orders when stock is low",
    category: "inventory",
    icon: ShoppingCart,
    triggerType: "field_change",
    targetModel: "products",
    triggerConditions: { 
      field: "current_stock",
      compare_to_field: "reorder_level",
      operator: "<="
    },
    steps: [
      {
        actionType: "create_linked",
        stepName: "Create Purchase Order",
        actionConfig: {
          target_type: "purchase_order",
          vendor: "{{preferred_vendor_id}}",
          items: [{
            product_id: "{{id}}",
            quantity: "{{reorder_quantity}}",
          }],
        },
      },
      {
        actionType: "send_notification",
        stepName: "Notify Purchasing",
        actionConfig: {
          title: "Auto-Reorder Created",
          message: "Purchase order created for {{name}} ({{reorder_quantity}} units)",
        },
      },
    ],
  },

  // === PURCHASING AUTOMATIONS ===
  {
    id: "po-approved-to-bill",
    name: "Create Bill on PO Receipt",
    description: "Automatically create a bill when a purchase order is received",
    category: "purchasing",
    icon: FileText,
    triggerType: "field_change",
    targetModel: "purchase_orders",
    triggerConditions: { field: "status", value: "received" },
    steps: [
      {
        actionType: "convert_document",
        stepName: "Create Bill",
        actionConfig: {
          target_type: "bill",
          copy_items: true,
        },
      },
      {
        actionType: "send_notification",
        stepName: "Notify Accounts Payable",
        actionConfig: {
          title: "New Bill Created",
          message: "Bill created from PO {{po_number}}",
          notify_roles: ["accounts_payable"],
        },
      },
    ],
  },

  // === ACCOUNTING AUTOMATIONS ===
  {
    id: "payment-reconciliation",
    name: "Auto-Reconcile Payments",
    description: "Automatically reconcile bank transactions with invoices",
    category: "accounting",
    icon: CreditCard,
    triggerType: "on_create",
    targetModel: "bank_transactions",
    triggerConditions: { field: "amount", operator: ">", value: 0 },
    steps: [
      {
        actionType: "run_code",
        stepName: "Find Matching Invoice",
        actionConfig: {
          function: "match_transaction_to_invoice",
        },
      },
      {
        actionType: "update_record",
        stepName: "Mark Reconciled",
        actionConfig: {
          is_reconciled: true,
          reconciled_at: "{{now}}",
        },
      },
    ],
  },
  {
    id: "recurring-invoice-notification",
    name: "Recurring Invoice Reminder",
    description: "Notify before recurring invoices are generated",
    category: "accounting",
    icon: Clock,
    triggerType: "time_based",
    targetModel: "recurring_invoices",
    triggerConditions: { days_before: 3, field: "next_invoice_date" },
    steps: [
      {
        actionType: "send_notification",
        stepName: "Remind About Upcoming Invoice",
        actionConfig: {
          title: "Recurring Invoice Due",
          message: "Recurring invoice for {{contact.name}} will be generated in 3 days",
        },
      },
    ],
  },
];

export const getTemplatesByCategory = (category: string) => {
  return automationTemplates.filter(t => t.category === category);
};

export const getPopularTemplates = () => {
  return automationTemplates.filter(t => t.isPopular);
};

export const getTemplateById = (id: string) => {
  return automationTemplates.find(t => t.id === id);
};

export const categoryLabels: Record<string, string> = {
  sales: "Sales",
  purchasing: "Purchasing",
  crm: "CRM",
  inventory: "Inventory",
  accounting: "Accounting",
  hr: "Human Resources",
};
