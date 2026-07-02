import { LandingHeader } from "@/components/landing/LandingHeader";
import { FooterSection } from "@/components/landing/CTASection";
import { FeaturesHero } from "@/components/features/FeaturesHero";
import { FeatureCategory } from "@/components/features/FeatureCategory";
import { FeatureNavigation } from "@/components/features/FeatureNavigation";
import { FeaturesCTA } from "@/components/features/FeaturesCTA";
import { 
  FileText, 
  Calculator, 
  BarChart3, 
  ShoppingCart, 
  Package, 
  CreditCard, 
  Bot, 
  Users,
  Receipt,
  RefreshCw,
  FileCheck,
  FileMinus,
  BookOpen,
  FileSpreadsheet,
  Banknote,
  Building2,
  TrendingUp,
  PieChart,
  ClipboardList,
  Truck,
  RotateCcw,
  Warehouse,
  Bell,
  Layers,
  Monitor,
  Wifi,
  WifiOff,
  Printer,
  Barcode,
  Heart,
  Smartphone,
  Sparkles,
  MessageSquare,
  Tags,
  LineChart,
  Globe,
  Shield,
  Clock,
  FolderKanban,
  // New icons for additional features
  Table2,
  Share2,
  FileSignature,
  PenTool,
  FolderOpen,
  Calendar,
  CalendarDays,
  Timer,
  Target,
  Briefcase,
  UserCheck,
  GanttChart,
  Milestone,
  CheckSquare,
  ArrowRightLeft,
  CloudOff,
  Handshake,
  Mail,
  Phone,
  Kanban,
  Trees as TreePalm,
  UserPlus,
  BadgeCheck,
  CircleDollarSign,
  UserCog,
  Coffee,
  Utensils,
  ChefHat,
  Armchair,
  UtensilsCrossed,
  ConciergeBell,
  BookMarked,
  CalendarClock,
  ListChecks
} from "lucide-react";

// Import images
import invoicingImage from "@/assets/feature-invoicing.jpg";
import expensesImage from "@/assets/feature-expenses.jpg";
import reportsImage from "@/assets/feature-reports.jpg";
import dashboardImage from "@/assets/hero-dashboard.jpg";

const featureCategories = [
  {
    id: "invoicing",
    title: "Invoicing & Billing",
    description: "Create professional invoices, manage recurring billing, and get paid faster with our comprehensive invoicing suite.",
    icon: FileText,
    color: "from-purple-500 to-purple-600",
    image: invoicingImage,
    imageAlt: "Professional invoicing interface",
    features: [
      {
        icon: Receipt,
        title: "Professional Invoices",
        description: "Create stunning, customizable invoices with your branding. Support for multiple currencies and tax configurations."
      },
      {
        icon: RefreshCw,
        title: "Recurring Invoices",
        description: "Automate your billing with scheduled recurring invoices. Set frequency, duration, and automatic email delivery."
      },
      {
        icon: FileCheck,
        title: "Estimates & Quotes",
        description: "Send professional estimates to clients. Convert approved quotes directly to invoices with one click."
      },
      {
        icon: FileMinus,
        title: "Credit Notes",
        description: "Issue credit notes for returns or adjustments. Automatically link to original invoices and apply to customer balances."
      },
      {
        icon: FileSpreadsheet,
        title: "Proforma Invoices",
        description: "Create proforma invoices for advance payments. Track deposits and convert to final invoices seamlessly."
      },
      {
        icon: Clock,
        title: "Payment Tracking",
        description: "Track invoice status, send payment reminders, and record partial or full payments with ease."
      }
    ]
  },
  {
    id: "accounting",
    title: "Accounting & Expenses",
    description: "Full double-entry accounting with expense tracking, journal entries, and comprehensive financial management.",
    icon: Calculator,
    color: "from-cyan-500 to-cyan-600",
    image: expensesImage,
    imageAlt: "Expense tracking dashboard",
    features: [
      {
        icon: BookOpen,
        title: "Chart of Accounts",
        description: "Complete double-entry accounting with customizable chart of accounts. Support for assets, liabilities, equity, revenue, and expenses."
      },
      {
        icon: FileSpreadsheet,
        title: "Journal Entries",
        description: "Record complex transactions with multi-line journal entries. Automatic balancing and audit trails."
      },
      {
        icon: Receipt,
        title: "Expense Tracking",
        description: "Track all business expenses with categories, vendors, and receipt attachments. Bulk import and export support."
      },
      {
        icon: Banknote,
        title: "Bills & Payables",
        description: "Manage vendor bills, track due dates, and schedule payments. Never miss a payment deadline."
      },
      {
        icon: Building2,
        title: "Bank Reconciliation",
        description: "Reconcile bank statements with transactions. Auto-matching suggestions and discrepancy tracking."
      },
      {
        icon: Calculator,
        title: "Tax Management",
        description: "Configure multiple tax rates, track tax collected and paid, and generate tax reports for filing."
      }
    ]
  },
  // Documents & e-Signatures feature card retired 2026-05-16.
  {
    id: "reports",
    title: "Reports & Analytics",
    description: "Powerful reporting suite with real-time dashboards, financial statements, and AI-powered insights.",
    icon: BarChart3,
    color: "from-green-500 to-green-600",
    image: reportsImage,
    imageAlt: "Financial reports and analytics",
    features: [
      {
        icon: TrendingUp,
        title: "Financial Reports",
        description: "Generate profit & loss, balance sheet, and cash flow statements. Compare periods and track trends."
      },
      {
        icon: PieChart,
        title: "Sales Reports",
        description: "Analyze sales by customer, product, or period. Track top performers and identify opportunities."
      },
      {
        icon: BarChart3,
        title: "Tax Reports",
        description: "Generate VAT/GST reports, withholding tax summaries, and tax liability statements for compliance."
      },
      {
        icon: Package,
        title: "Stock Reports",
        description: "Inventory valuation, stock movement, aging analysis, and ABC classification reports."
      },
      {
        icon: LineChart,
        title: "Management Reports",
        description: "Customer aging, vendor aging, budget vs actual, and custom management dashboards."
      },
      {
        icon: Sparkles,
        title: "AI-Powered Insights",
        description: "Get intelligent recommendations, anomaly detection, and predictive analytics powered by AI."
      }
    ]
  },
  {
    id: "sales",
    title: "Sales & Purchase Management",
    description: "Complete order-to-cash and procure-to-pay workflows with full document tracking.",
    icon: ShoppingCart,
    color: "from-orange-500 to-orange-600",
    image: dashboardImage,
    imageAlt: "Sales management dashboard",
    features: [
      {
        icon: ClipboardList,
        title: "Sales Orders",
        description: "Create and manage sales orders. Track order status, allocate inventory, and convert to invoices."
      },
      {
        icon: ShoppingCart,
        title: "Purchase Orders",
        description: "Generate purchase orders from reorder points or manually. Track deliveries and convert to bills."
      },
      {
        icon: Truck,
        title: "Delivery Notes",
        description: "Create delivery notes from sales orders. Track partial deliveries and print packing slips."
      },
      {
        icon: RotateCcw,
        title: "Sales Returns",
        description: "Process customer returns with return authorization. Automatic inventory and accounting updates."
      },
      {
        icon: RotateCcw,
        title: "Purchase Returns",
        description: "Handle vendor returns and debit notes. Track return shipments and credits received."
      },
      {
        icon: FileText,
        title: "Customer Statements",
        description: "Generate and send periodic customer statements. Track outstanding balances and payment history."
      }
    ]
  },
  {
    id: "inventory",
    title: "Inventory & Warehouse",
    description: "Comprehensive inventory management with multi-warehouse support, stock tracking, and automated reordering.",
    icon: Package,
    color: "from-amber-500 to-amber-600",
    features: [
      {
        icon: Package,
        title: "Product Management",
        description: "Manage products with variants, bundles, and kits. Support for serial numbers and batch tracking."
      },
      {
        icon: Layers,
        title: "Stock Tracking",
        description: "Real-time stock levels across all locations. Track reserved, available, and in-transit quantities."
      },
      {
        icon: Warehouse,
        title: "Multi-Warehouse",
        description: "Manage multiple warehouses and locations. Inter-warehouse transfers and location-specific pricing."
      },
      {
        icon: Bell,
        title: "Low Stock Alerts",
        description: "Automatic notifications when stock falls below reorder points. Generate purchase orders automatically."
      },
      {
        icon: Truck,
        title: "Stock Transfers",
        description: "Move inventory between warehouses. Track in-transit stock and transfer costs."
      },
      {
        icon: BarChart3,
        title: "ABC Analysis",
        description: "Classify inventory by value and movement. Optimize stock levels and reduce carrying costs."
      }
    ]
  },
  {
    id: "pos",
    title: "Point of Sale (POS)",
    description: "Enterprise-grade POS system with offline capabilities, hardware integration, and restaurant mode.",
    icon: CreditCard,
    color: "from-emerald-500 to-emerald-600",
    features: [
      {
        icon: Monitor,
        title: "Multi-Register POS",
        description: "Run multiple POS terminals simultaneously. Shift management, cash drawer tracking, and X/Z reports."
      },
      {
        icon: WifiOff,
        title: "Offline-First Architecture",
        description: "Continue selling even without internet. Automatic sync when connection is restored."
      },
      {
        icon: Barcode,
        title: "Hardware Integration",
        description: "Connect barcode scanners, receipt printers, cash drawers, and weighing scales."
      },
      {
        icon: Smartphone,
        title: "Phone-Assisted Scanning",
        description: "Turn any staff phone into a wireless barcode scanner. Pair via QR code and scan straight into the active POS, Sales, or Inventory screen."
      },
      {
        icon: Heart,
        title: "Loyalty Programs",
        description: "Points-based loyalty with tiers and rewards. Track customer visits and spending."
      },
      {
        icon: Smartphone,
        title: "Mobile Payments",
        description: "Accept M-Pesa, card payments, and multiple payment methods on a single transaction."
      },
      {
        icon: Shield,
        title: "Age Verification",
        description: "Built-in age verification for restricted products. Compliance tracking and reporting."
      }
    ]
  },
  {
    id: "restaurant",
    title: "Restaurant Mode",
    description: "Full-featured restaurant management with table layouts, kitchen display, courses, and reservations.",
    icon: Utensils,
    color: "from-rose-500 to-rose-600",
    features: [
      {
        icon: Armchair,
        title: "Floor Plan Designer",
        description: "Visual table layout designer. Drag and drop tables, sections, and create multiple floors."
      },
      {
        icon: ChefHat,
        title: "Kitchen Display System",
        description: "Real-time order display for kitchen staff. Priority queue and order timing."
      },
      {
        icon: UtensilsCrossed,
        title: "Course Management",
        description: "Fire courses at the right time. Coordinate appetizers, mains, and desserts seamlessly."
      },
      {
        icon: ConciergeBell,
        title: "Table Service",
        description: "Assign servers to tables. Split bills, transfer items, and merge tables."
      },
      {
        icon: BookMarked,
        title: "Reservations",
        description: "Online and phone reservations. Table availability, party size, and special requests."
      },
      {
        icon: ArrowRightLeft,
        title: "Quick Transfers",
        description: "Move items between tables or merge multiple tables into one bill."
      }
    ]
  },
  {
    id: "contacts",
    title: "Contacts Management",
    description: "Centralized contact hub for customers, suppliers, and companies with powerful filtering and search.",
    icon: Users,
    color: "from-slate-500 to-slate-600",
    features: [
      {
        icon: Users,
        title: "All Contacts",
        description: "Unified view of all your contacts — customers, suppliers, and companies in one place."
      },
      {
        icon: UserCheck,
        title: "Customer Directory",
        description: "Filter and manage your customer base. Track balances, purchase history, and contact details."
      },
      {
        icon: Building2,
        title: "Vendor Directory",
        description: "Manage vendor relationships with dedicated views, payment terms, and purchase tracking."
      },
      {
        icon: Briefcase,
        title: "Company Profiles",
        description: "Group contacts under company profiles. Track multiple contacts per organization."
      },
      {
        icon: Tags,
        title: "Smart Filtering",
        description: "Filter contacts by type, company, tags, and custom fields. Save frequently used filters."
      },
      {
        icon: ArrowRightLeft,
        title: "Import & Export",
        description: "Bulk import contacts from CSV/Excel. Export your contact database anytime."
      }
    ]
  },
  {
    id: "crm",
    title: "CRM & Sales Pipeline",
    description: "Complete customer relationship management with visual pipelines, activities, and deal tracking.",
    icon: Handshake,
    color: "from-blue-500 to-blue-600",
    features: [
      {
        icon: Kanban,
        title: "Visual Pipeline",
        description: "Drag-and-drop deal stages. Customize pipelines for different sales processes."
      },
      {
        icon: Target,
        title: "Lead Management",
        description: "Capture and qualify leads. Score leads and route to the right sales rep."
      },
      {
        icon: Phone,
        title: "Activity Tracking",
        description: "Log calls, emails, and meetings. Set follow-up reminders and tasks."
      },
      {
        icon: CircleDollarSign,
        title: "Deal Tracking",
        description: "Track deal value, probability, and expected close date. Forecast revenue accurately."
      },
      {
        icon: Users,
        title: "Contact Management",
        description: "360-degree view of customers. Track interactions, purchases, and support history."
      },
      {
        icon: Mail,
        title: "Email Integration",
        description: "Send emails directly from CRM. Track opens, clicks, and replies."
      }
    ]
  },
  {
    id: "projects",
    title: "Projects & Tasks",
    description: "Project management with task tracking, timelines, and team collaboration tools.",
    icon: FolderKanban,
    color: "from-sky-500 to-sky-600",
    features: [
      {
        icon: Briefcase,
        title: "Project Dashboard",
        description: "Overview of all projects with status, progress, and team members at a glance."
      },
      {
        icon: CheckSquare,
        title: "Task Management",
        description: "Create, assign, and track tasks. Set priorities, due dates, and dependencies."
      },
      {
        icon: GanttChart,
        title: "Timeline View",
        description: "Visual project timeline with milestones. Track progress against deadlines."
      },
      {
        icon: Milestone,
        title: "Milestones",
        description: "Define key project milestones. Track completion and celebrate achievements."
      },
      {
        icon: Timer,
        title: "Time Tracking",
        description: "Log time against tasks and projects. Generate billable time reports."
      },
      {
        icon: Users,
        title: "Team Collaboration",
        description: "Comments, file attachments, and @mentions. Keep everyone on the same page."
      }
    ]
  },
  {
    id: "timesheets",
    title: "Timesheets & Time Tracking",
    description: "Track employee time with approval workflows, overtime calculation, and payroll integration.",
    icon: Timer,
    color: "from-lime-500 to-lime-600",
    features: [
      {
        icon: CalendarDays,
        title: "Weekly Timesheets",
        description: "Easy weekly timesheet entry. Copy from previous week or templates."
      },
      {
        icon: Clock,
        title: "Time Logging",
        description: "Log time by project, task, or client. Billable and non-billable tracking."
      },
      {
        icon: UserCheck,
        title: "Approval Workflow",
        description: "Submit timesheets for approval. Manager review and approval process."
      },
      {
        icon: Calculator,
        title: "Overtime Calculation",
        description: "Automatic overtime detection based on work rules. Daily and weekly limits."
      },
      {
        icon: CircleDollarSign,
        title: "Payroll Integration",
        description: "Approved timesheets flow directly to payroll. Accurate pay calculation."
      },
      {
        icon: BarChart3,
        title: "Utilization Reports",
        description: "Track billable vs non-billable hours. Team utilization and productivity metrics."
      }
    ]
  },
  {
    id: "leave",
    title: "Leave Management",
    description: "Complete leave and absence management with policies, approvals, and calendar integration.",
    icon: TreePalm,
    color: "from-fuchsia-500 to-fuchsia-600",
    features: [
      {
        icon: Calendar,
        title: "Leave Calendar",
        description: "Visual team calendar showing who's out. Plan coverage and avoid conflicts."
      },
      {
        icon: ListChecks,
        title: "Leave Policies",
        description: "Configure leave types, accrual rules, and carryover policies per department or role."
      },
      {
        icon: UserCheck,
        title: "Request & Approval",
        description: "Easy leave requests with manager approval workflow. Email notifications."
      },
      {
        icon: CalendarClock,
        title: "Balance Tracking",
        description: "Real-time leave balances. Automatic accrual and usage tracking."
      },
      {
        icon: Coffee,
        title: "Holiday Calendar",
        description: "Configure public holidays by location. Automatic exclusion from leave days."
      },
      {
        icon: BarChart3,
        title: "Absence Reports",
        description: "Track leave patterns, absence rates, and remaining balances across the team."
      }
    ]
  },
  {
    id: "hr",
    title: "HR & Payroll",
    description: "Complete human resources management with employee records, departments, leave tracking, and payroll processing.",
    icon: Briefcase,
    color: "from-amber-500 to-amber-600",
    features: [
      {
        icon: Users,
        title: "Employee Management",
        description: "Comprehensive employee records with personal details, documents, and employment history."
      },
      {
        icon: Building2,
        title: "Departments & Structure",
        description: "Organize employees by department, designation, and reporting hierarchy."
      },
      {
        icon: Calendar,
        title: "Leave Management",
        description: "Configure leave types, accrual policies, and approval workflows per department."
      },
      {
        icon: CircleDollarSign,
        title: "Payroll Processing",
        description: "Run payroll with automatic tax calculations, deductions, and statutory compliance."
      },
      {
        icon: UserCheck,
        title: "Onboarding & Offboarding",
        description: "Structured checklists for new hires and departing employees. Track completion."
      },
      {
        icon: BarChart3,
        title: "HR Analytics",
        description: "Headcount reports, attrition analysis, leave utilization, and workforce planning."
      }
    ]
  },
  {
    id: "studio",
    title: "Studio & Customization",
    description: "Customize your ERP with custom fields, automated workflows, custom views, and report scheduling.",
    icon: PenTool,
    color: "from-violet-500 to-violet-600",
    features: [
      {
        icon: PenTool,
        title: "Custom Fields",
        description: "Add custom fields to any module — text, numbers, dates, dropdowns, and more."
      },
      {
        icon: RefreshCw,
        title: "Automated Actions",
        description: "Create triggers and actions that run automatically when conditions are met."
      },
      {
        icon: Layers,
        title: "Custom Views",
        description: "Design custom list, form, and kanban views tailored to your workflow."
      },
      {
        icon: FileSpreadsheet,
        title: "Report Builder",
        description: "Build custom reports with drag-and-drop fields, filters, and grouping."
      },
      {
        icon: Clock,
        title: "Scheduled Reports",
        description: "Schedule reports to be generated and emailed automatically on a recurring basis."
      },
      {
        icon: Shield,
        title: "Form Designer",
        description: "Create custom forms for data collection, surveys, and approval workflows."
      }
    ]
  },
  {
    id: "ai",
    title: "AI-Powered Features",
    description: "Leverage artificial intelligence for smarter insights, automation, and decision-making.",
    icon: Bot,
    color: "from-pink-500 to-pink-600",
    features: [
      {
        icon: MessageSquare,
        title: "AI Financial Assistant",
        description: "Chat with your financial data. Ask questions in natural language and get instant answers."
      },
      {
        icon: Sparkles,
        title: "Smart Insights",
        description: "AI analyzes your data to surface opportunities, risks, and recommendations automatically."
      },
      {
        icon: Tags,
        title: "Auto-Categorization",
        description: "AI learns from your patterns to automatically categorize transactions and expenses."
      },
      {
        icon: LineChart,
        title: "Predictive Analytics",
        description: "Forecast cash flow, predict customer behavior, and anticipate inventory needs."
      },
      {
        icon: FileCheck,
        title: "Document Processing",
        description: "Extract data from invoices and receipts automatically using OCR and AI."
      },
      {
        icon: TrendingUp,
        title: "Anomaly Detection",
        description: "Identify unusual transactions, duplicate payments, and potential fraud automatically."
      }
    ]
  },
  {
    id: "team",
    title: "Team & Organization",
    description: "Collaborate with your team, manage multiple organizations, and maintain complete audit trails.",
    icon: Users,
    color: "from-indigo-500 to-indigo-600",
    features: [
      {
        icon: Building2,
        title: "Multi-Organization",
        description: "Manage multiple companies from one account. Switch between organizations seamlessly."
      },
      {
        icon: Users,
        title: "Team Collaboration",
        description: "Invite team members with role-based access. Track who did what and when."
      },
      {
        icon: Shield,
        title: "Role-Based Permissions",
        description: "Fine-grained access control. Define what each role can view, create, edit, or delete."
      },
      {
        icon: Clock,
        title: "Audit Logs",
        description: "Complete audit trail of all actions. Track changes, access, and modifications."
      },
      {
        icon: Globe,
        title: "Multi-Currency",
        description: "Support for multiple currencies with automatic exchange rate updates."
      },
      {
        icon: UserCog,
        title: "Employee Management",
        description: "Manage employee profiles, departments, and reporting structures."
      }
    ]
  }
];

export default function Features() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-muted/30 to-background">
      <LandingHeader />
      <FeaturesHero />
      <FeatureNavigation categories={featureCategories} />
      
      <div className="relative">
        {featureCategories.map((category, index) => (
          <FeatureCategory
            key={category.id}
            category={category}
            index={index}
          />
        ))}
      </div>
      
      <FeaturesCTA />
      <FooterSection />
    </div>
  );
}
