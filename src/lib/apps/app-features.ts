/**
 * App Feature Content
 * 
 * Marketing content for app landing pages - features, benefits,
 * and descriptions shown when users first access an app.
 */

import { 
  CheckCircle, 
  Zap, 
  Shield, 
  BarChart3, 
  Clock, 
  Globe,
  Users,
  CreditCard,
  Package,
  Truck,
  MessageSquare,
  ScrollText,
  type LucideIcon 
} from "lucide-react";

export interface AppFeature {
  icon: LucideIcon;
  title: string;
  description: string;
}

export interface AppBenefit {
  text: string;
}

export interface AppContent {
  tagline: string;
  headline: string;
  description: string;
  features: AppFeature[];
  benefits: AppBenefit[];
  ctaText: string;
  secondaryCtaText?: string;
}

/**
 * Feature content for each app
 */
export const APP_CONTENT: Record<string, AppContent> = {
  finance: {
    tagline: "Complete Financial Management",
    headline: "Take control of your business finances",
    description: "Manage your chart of accounts, track transactions, reconcile bank statements, and generate financial reports - all in one place.",
    features: [
      {
        icon: BarChart3,
        title: "Real-time Reporting",
        description: "Get instant access to profit & loss, balance sheets, and cash flow statements.",
      },
      {
        icon: Shield,
        title: "Bank Reconciliation",
        description: "Automatically match bank transactions with your records for accurate books.",
      },
      {
        icon: Clock,
        title: "Automated Entries",
        description: "Set up recurring journal entries and let the system handle the rest.",
      },
      {
        icon: Globe,
        title: "Multi-Currency",
        description: "Handle transactions in multiple currencies with automatic exchange rates.",
      },
    ],
    benefits: [
      { text: "Reduce month-end close time by 50%" },
      { text: "Eliminate manual data entry errors" },
      { text: "Always audit-ready with complete trail" },
      { text: "Real-time visibility into financial health" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "Meet an Advisor",
  },
  sales: {
    tagline: "Streamline Your Sales Process",
    headline: "Convert quotes to cash faster",
    description: "Create professional invoices, manage orders, track payments, and keep customers happy with automated reminders and statements.",
    features: [
      {
        icon: Zap,
        title: "Quick Invoicing",
        description: "Create and send professional invoices in seconds with customizable templates.",
      },
      {
        icon: CreditCard,
        title: "Payment Tracking",
        description: "Track payments, send reminders, and manage receivables effortlessly.",
      },
      {
        icon: Users,
        title: "Customer Portal",
        description: "Let customers view invoices and pay online through a branded portal.",
      },
      {
        icon: BarChart3,
        title: "Sales Analytics",
        description: "Track performance, identify trends, and forecast revenue accurately.",
      },
    ],
    benefits: [
      { text: "Get paid 2x faster with online payments" },
      { text: "Reduce invoice disputes by 80%" },
      { text: "Automate payment reminders" },
      { text: "Build stronger customer relationships" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "See Demo",
  },
  purchases: {
    tagline: "Smart Expense Management",
    headline: "Control spending, maximize savings",
    description: "Manage vendor bills, track expenses, create purchase orders, and maintain complete visibility over your spending.",
    features: [
      {
        icon: Package,
        title: "Purchase Orders",
        description: "Create and track purchase orders with approval workflows.",
      },
      {
        icon: Shield,
        title: "Bill Management",
        description: "Capture, approve, and pay vendor bills with complete audit trails.",
      },
      {
        icon: BarChart3,
        title: "Expense Analytics",
        description: "Understand spending patterns and identify cost-saving opportunities.",
      },
      {
        icon: Clock,
        title: "Payment Scheduling",
        description: "Schedule payments to optimize cash flow and avoid late fees.",
      },
    ],
    benefits: [
      { text: "Never miss a payment deadline" },
      { text: "Reduce processing costs by 60%" },
      { text: "Capture early payment discounts" },
      { text: "Complete spending visibility" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "Learn More",
  },
  inventory: {
    tagline: "Inventory Made Simple",
    headline: "Know your stock, optimize your supply",
    description: "Track products across warehouses, manage stock levels, set reorder points, and never run out of what you need.",
    features: [
      {
        icon: Package,
        title: "Real-time Stock",
        description: "Know exactly what you have, where it is, and when to reorder.",
      },
      {
        icon: Truck,
        title: "Multi-Warehouse",
        description: "Manage inventory across multiple locations with transfer tracking.",
      },
      {
        icon: BarChart3,
        title: "Stock Valuation",
        description: "Track inventory value using FIFO, LIFO, or average costing.",
      },
      {
        icon: Zap,
        title: "Smart Alerts",
        description: "Get notified when stock levels hit reorder points.",
      },
    ],
    benefits: [
      { text: "Reduce stockouts by 90%" },
      { text: "Optimize inventory carrying costs" },
      { text: "Accurate cost of goods sold" },
      { text: "Streamline order fulfillment" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "See Demo",
  },
  pos: {
    tagline: "Modern Point of Sale",
    headline: "Sell anywhere, manage everywhere",
    description: "A powerful POS system that works online and offline, with inventory sync, customer management, and real-time reporting.",
    features: [
      {
        icon: Zap,
        title: "Lightning Fast",
        description: "Process sales in seconds with an intuitive touch interface.",
      },
      {
        icon: Globe,
        title: "Works Offline",
        description: "Keep selling even without internet - syncs when back online.",
      },
      {
        icon: Users,
        title: "Customer Loyalty",
        description: "Build loyalty programs and track customer purchase history.",
      },
      {
        icon: BarChart3,
        title: "Live Reporting",
        description: "Monitor sales performance in real-time from anywhere.",
      },
    ],
    benefits: [
      { text: "Increase checkout speed by 40%" },
      { text: "Unified inventory across channels" },
      { text: "Better customer insights" },
      { text: "Reduce cash discrepancies" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "Request Demo",
  },
  crm: {
    tagline: "Relationship Intelligence",
    headline: "Turn contacts into customers",
    description: "Manage your sales pipeline, track activities, nurture leads, and close more deals with a 360° view of every relationship.",
    features: [
      {
        icon: Users,
        title: "Pipeline Management",
        description: "Visualize and manage deals through customizable sales stages.",
      },
      {
        icon: Clock,
        title: "Activity Tracking",
        description: "Log calls, meetings, and emails with automatic reminders.",
      },
      {
        icon: BarChart3,
        title: "Sales Forecasting",
        description: "Predict revenue with AI-powered deal scoring.",
      },
      {
        icon: Zap,
        title: "Automation",
        description: "Automate follow-ups and never let a lead go cold.",
      },
    ],
    benefits: [
      { text: "Close deals 30% faster" },
      { text: "Never lose track of a lead" },
      { text: "Improve team collaboration" },
      { text: "Data-driven sales decisions" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "See Demo",
  },
  hr: {
    tagline: "People Operations",
    headline: "Empower your team, simplify HR",
    description: "Manage employees, track time off, process payroll, and build a great workplace with modern HR tools.",
    features: [
      {
        icon: Users,
        title: "Employee Directory",
        description: "Centralized employee profiles with org charts and reporting.",
      },
      {
        icon: Clock,
        title: "Leave Management",
        description: "Track PTO, sick leave, and holidays with approval workflows.",
      },
      {
        icon: CreditCard,
        title: "Payroll Processing",
        description: "Run payroll accurately with tax calculations and direct deposit.",
      },
      {
        icon: BarChart3,
        title: "HR Analytics",
        description: "Track headcount, turnover, and other key HR metrics.",
      },
    ],
    benefits: [
      { text: "Reduce payroll errors to zero" },
      { text: "Streamline leave approvals" },
      { text: "Improve employee satisfaction" },
      { text: "Stay compliant with regulations" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "Learn More",
  },
  projects: {
    tagline: "Project Excellence",
    headline: "Deliver projects on time, every time",
    description: "Plan projects, assign tasks, track time, and collaborate with your team to deliver exceptional results.",
    features: [
      {
        icon: CheckCircle,
        title: "Task Management",
        description: "Break projects into tasks with assignments and deadlines.",
      },
      {
        icon: Clock,
        title: "Time Tracking",
        description: "Track billable hours and generate timesheets automatically.",
      },
      {
        icon: Users,
        title: "Team Collaboration",
        description: "Comment, share files, and keep everyone aligned.",
      },
      {
        icon: BarChart3,
        title: "Project Analytics",
        description: "Monitor progress, budgets, and profitability in real-time.",
      },
    ],
    benefits: [
      { text: "Improve project profitability by 25%" },
      { text: "Accurate time and billing" },
      { text: "Better resource utilization" },
      { text: "Happy clients, repeat business" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "See Demo",
  },
  reports: {
    tagline: "Business Intelligence",
    headline: "Data-driven decisions, faster growth",
    description: "Access powerful reports, create custom dashboards, and gain insights that drive your business forward.",
    features: [
      {
        icon: BarChart3,
        title: "Pre-built Reports",
        description: "Access 50+ ready-to-use financial and operational reports.",
      },
      {
        icon: Zap,
        title: "Custom Dashboards",
        description: "Build personalized dashboards with drag-and-drop widgets.",
      },
      {
        icon: Globe,
        title: "Export & Share",
        description: "Export to Excel, PDF, or share live reports with stakeholders.",
      },
      {
        icon: Clock,
        title: "Scheduled Reports",
        description: "Automate report delivery to your inbox daily or weekly.",
      },
    ],
    benefits: [
      { text: "Make decisions 3x faster" },
      { text: "Spot trends before competitors" },
      { text: "Share insights with stakeholders" },
      { text: "One source of truth for data" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "Explore Reports",
  },
  // documents + sign + spreadsheets retired 2026-05-09 — entries removed.
  sms: {
    tagline: "SMS Notifications",
    headline: "Keep customers informed via SMS",
    description: "Send transactional SMS notifications for invoices, payments, and more using your own Twilio account. You control the billing.",
    features: [
      {
        icon: MessageSquare,
        title: "Transactional SMS",
        description: "Automatically notify customers when invoices are posted or payments received.",
      },
      {
        icon: Zap,
        title: "Event-Driven",
        description: "Configure which business events trigger SMS — fully customizable per event.",
      },
      {
        icon: ScrollText,
        title: "Message Templates",
        description: "Create reusable templates with dynamic variables like customer name and amount.",
      },
      {
        icon: Shield,
        title: "BYO Provider",
        description: "Bring your own Twilio account. Credentials stored securely, billed directly by Twilio.",
      },
    ],
    benefits: [
      { text: "Improve payment collection rates" },
      { text: "Keep customers in the loop automatically" },
      { text: "Full audit log of every message sent" },
      { text: "No platform markup — pay Twilio directly" },
    ],
    ctaText: "Configure SMS",
  },
};

/**
 * Get content for an app, with fallback for unknown apps
 */
export function getAppContent(appId: string): AppContent {
  return APP_CONTENT[appId] || {
    tagline: "Powerful Tools",
    headline: "Streamline your workflow",
    description: "Discover powerful features designed to help your business grow.",
    features: [],
    benefits: [],
    ctaText: "Get Started",
  };
}
