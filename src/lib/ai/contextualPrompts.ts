import {
  Wallet, TrendingUp, Package, Calendar, Briefcase, ShoppingCart,
  Users, FileText, Receipt, Target, BarChart3, Wand2, FolderOpen,
  Table2, PenTool, HelpCircle, Settings, LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

interface ContextualPrompt {
  text: string;
  icon: LucideIcon;
}

const PROMPTS: Record<string, ContextualPrompt[]> = {
  "/finance": [
    { text: "What's my cash flow status?", icon: Wallet },
    { text: "Reconciliation status", icon: TrendingUp },
    { text: "Account balances summary", icon: BarChart3 },
  ],
  "/sales": [
    { text: "Overdue invoices summary", icon: Receipt },
    { text: "Top customers by revenue", icon: Users },
    { text: "Pending estimates", icon: FileText },
  ],
  "/purchases": [
    { text: "Pending bills to pay", icon: Receipt },
    { text: "Expense breakdown this month", icon: Wallet },
    { text: "Purchase order status", icon: Package },
  ],
  "/inventory-app": [
    { text: "Show low stock products", icon: Package },
    { text: "Inventory valuation", icon: BarChart3 },
    { text: "Products needing reorder", icon: Package },
  ],
  "/pos": [
    { text: "Today's POS sales summary", icon: ShoppingCart },
    { text: "Best-selling items today", icon: TrendingUp },
    { text: "Sales by register", icon: ShoppingCart },
  ],
  "/hr": [
    { text: "Pending leave requests", icon: Calendar },
    { text: "Employee count by department", icon: Users },
    { text: "Upcoming payroll", icon: Wallet },
  ],
  "/crm-app": [
    { text: "Open leads summary", icon: Target },
    { text: "Pipeline value", icon: TrendingUp },
    { text: "Follow-ups due today", icon: Calendar },
  ],
  "/contacts-app": [
    { text: "Top customers", icon: Users },
    { text: "Suppliers with pending bills", icon: Receipt },
    { text: "Recent contacts added", icon: Users },
  ],
  "/reports": [
    { text: "Revenue vs expenses trend", icon: BarChart3 },
    { text: "Profit margin analysis", icon: TrendingUp },
    { text: "Aging report summary", icon: FileText },
  ],
  "/studio": [
    { text: "Walk me through Studio's capabilities", icon: Wand2 },
    { text: "How do I add a custom field to invoices?", icon: Wand2 },
    { text: "Help me create an automation workflow", icon: Wand2 },
  ],
  "/studio/automations": [
    { text: "Create an automation that sends email on invoice creation", icon: Wand2 },
    { text: "What triggers and actions are available?", icon: Wand2 },
    { text: "How do I set up a scheduled automation?", icon: Wand2 },
  ],
  "/studio/views": [
    { text: "How do I create a Kanban view for leads?", icon: Wand2 },
    { text: "What view types can I create?", icon: Wand2 },
    { text: "How to set a default view for contacts?", icon: Wand2 },
  ],
  "/studio/forms": [
    { text: "How do I organize fields into tabs and groups?", icon: Wand2 },
    { text: "Create a custom form layout for invoices", icon: Wand2 },
    { text: "What are form layout columns and field widths?", icon: Wand2 },
  ],
  "/studio/reports": [
    { text: "How do I design a custom invoice template?", icon: Wand2 },
    { text: "What template variables are available?", icon: Wand2 },
    { text: "Help me set up a report with header and footer", icon: Wand2 },
  ],
  "/studio/scheduling": [
    { text: "Schedule a weekly balance sheet report", icon: Wand2 },
    { text: "How do I set up automatic report emailing?", icon: Wand2 },
    { text: "What report types can be scheduled?", icon: Wand2 },
  ],
  "/spreadsheets": [
    { text: "How do I create a new spreadsheet?", icon: Table2 },
    { text: "Help with formulas", icon: Table2 },
    { text: "How to share a spreadsheet?", icon: Table2 },
  ],
  "/sign": [
    { text: "How do I create a signature request?", icon: PenTool },
    { text: "Guide me through templates", icon: PenTool },
    { text: "How to track signing status?", icon: PenTool },
  ],
  "/settings/studio": [
    { text: "Walk me through Studio's capabilities", icon: Wand2 },
    { text: "How do I add a custom field to invoices?", icon: Wand2 },
    { text: "Help me create an automation workflow", icon: Wand2 },
  ],
  "/settings": [
    { text: "How do I manage team members?", icon: Settings },
    { text: "Guide me through organization settings", icon: Settings },
    { text: "How to configure notifications?", icon: Settings },
  ],
  "/dashboard": [
    { text: "Give me a business overview", icon: LayoutDashboard },
    { text: "What needs my attention today?", icon: LayoutDashboard },
    { text: "Summary of recent activity", icon: LayoutDashboard },
  ],
};

const DEFAULT_PROMPTS: ContextualPrompt[] = [
  { text: "Give me a business overview", icon: LayoutDashboard },
  { text: "What needs my attention today?", icon: HelpCircle },
  { text: "Help me navigate this system", icon: HelpCircle },
];

// Order matters: longer/more-specific prefixes must be checked first
const ORDERED_PREFIXES = Object.keys(PROMPTS).sort((a, b) => b.length - a.length);

export function getContextualPrompts(path: string): ContextualPrompt[] {
  for (const prefix of ORDERED_PREFIXES) {
    if (path.startsWith(prefix)) return PROMPTS[prefix];
  }
  return DEFAULT_PROMPTS;
}
