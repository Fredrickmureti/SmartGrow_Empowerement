import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "next-themes";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FileText,
  BarChart3,
  Users,
  CreditCard,
  Calculator,
  Package,
  ShoppingCart,
  Bot,
  Building2,
  Briefcase,
  UserCheck,
  Building,
  HelpCircle,
  BookOpen,
  Mail,
  Menu,
  ChevronDown,
  ArrowRight,
  Sun,
  Moon,
  Monitor,
  PenTool,
  FolderKanban,
  Timer,
  Palmtree,
  Handshake,
  Utensils,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";

const featuresData = [
  {
    category: "Invoicing & Billing",
    icon: FileText,
    color: "text-purple-400",
    items: [
      { title: "Professional Invoices", href: "/features#invoicing" },
      { title: "Recurring Invoices", href: "/features#invoicing" },
      { title: "Estimates & Quotes", href: "/features#invoicing" },
      { title: "Credit Notes", href: "/features#invoicing" },
    ],
  },
  {
    category: "Accounting & Expenses",
    icon: Calculator,
    color: "text-cyan-400",
    items: [
      { title: "Chart of Accounts", href: "/features#accounting" },
      { title: "Journal Entries", href: "/features#accounting" },
      { title: "Expense Tracking", href: "/features#accounting" },
      { title: "Bank Reconciliation", href: "/features#accounting" },
    ],
  },
  {
    category: "Reports & Analytics",
    icon: BarChart3,
    color: "text-green-400",
    items: [
      { title: "Financial Reports", href: "/features#reports" },
      { title: "Sales Reports", href: "/features#reports" },
      { title: "Tax Reports", href: "/features#reports" },
      { title: "AI-Powered Insights", href: "/features#reports" },
    ],
  },
  {
    category: "Sales & Purchases",
    icon: ShoppingCart,
    color: "text-orange-400",
    items: [
      { title: "Sales Orders", href: "/features#sales" },
      { title: "Purchase Orders", href: "/features#sales" },
      { title: "Delivery Notes", href: "/features#sales" },
      { title: "Returns Management", href: "/features#sales" },
    ],
  },
  {
    category: "Inventory & Warehouse",
    icon: Package,
    color: "text-amber-400",
    items: [
      { title: "Product Management", href: "/features#inventory" },
      { title: "Stock Tracking", href: "/features#inventory" },
      { title: "Multi-Warehouse", href: "/features#inventory" },
      { title: "Low Stock Alerts", href: "/features#inventory" },
    ],
  },
  {
    category: "Point of Sale",
    icon: CreditCard,
    color: "text-emerald-400",
    items: [
      { title: "Multi-Register POS", href: "/features#pos" },
      { title: "Offline-First Mode", href: "/features#pos" },
      { title: "Loyalty Programs", href: "/features#pos" },
      { title: "Hardware Integration", href: "/features#pos" },
    ],
  },
  {
    category: "Restaurant Mode",
    icon: Utensils,
    color: "text-rose-400",
    items: [
      { title: "Floor Plan Designer", href: "/features#restaurant" },
      { title: "Kitchen Display", href: "/features#restaurant" },
      { title: "Table Service", href: "/features#restaurant" },
      { title: "Reservations", href: "/features#restaurant" },
    ],
  },
  {
    category: "Contacts",
    icon: Users,
    color: "text-slate-400",
    items: [
      { title: "All Contacts", href: "/features#contacts" },
      { title: "Customer Directory", href: "/features#contacts" },
      { title: "Vendor Directory", href: "/features#contacts" },
      { title: "Company Profiles", href: "/features#contacts" },
    ],
  },
  {
    category: "CRM & Sales Pipeline",
    icon: Handshake,
    color: "text-blue-400",
    items: [
      { title: "Visual Pipeline", href: "/features#crm" },
      { title: "Lead Management", href: "/features#crm" },
      { title: "Deal Tracking", href: "/features#crm" },
      { title: "Contact Management", href: "/features#crm" },
    ],
  },
  {
    category: "Projects & Tasks",
    icon: FolderKanban,
    color: "text-sky-400",
    items: [
      { title: "Project Dashboard", href: "/features#projects" },
      { title: "Task Management", href: "/features#projects" },
      { title: "Timeline View", href: "/features#projects" },
      { title: "Time Tracking", href: "/features#projects" },
    ],
  },
  {
    category: "Timesheets",
    icon: Timer,
    color: "text-lime-400",
    items: [
      { title: "Weekly Timesheets", href: "/features#timesheets" },
      { title: "Approval Workflow", href: "/features#timesheets" },
      { title: "Overtime Calculation", href: "/features#timesheets" },
      { title: "Payroll Integration", href: "/features#timesheets" },
    ],
  },
  {
    category: "Leave Management",
    icon: Palmtree,
    color: "text-fuchsia-400",
    items: [
      { title: "Leave Calendar", href: "/features#leave" },
      { title: "Leave Policies", href: "/features#leave" },
      { title: "Balance Tracking", href: "/features#leave" },
      { title: "Absence Reports", href: "/features#leave" },
    ],
  },
  // Spreadsheets and Documents & e-Signatures categories retired 2026-05-17 —
  // those apps were removed from the platform to keep focus on accounting.
  {
    category: "HR & Payroll",
    icon: Briefcase,
    color: "text-amber-400",
    items: [
      { title: "Employee Management", href: "/features#hr" },
      { title: "Departments", href: "/features#hr" },
      { title: "Payroll Processing", href: "/features#hr" },
      { title: "HR Analytics", href: "/features#hr" },
    ],
  },
  {
    category: "Studio",
    icon: PenTool,
    color: "text-violet-400",
    items: [
      { title: "Custom Fields", href: "/features#studio" },
      { title: "Automated Actions", href: "/features#studio" },
      { title: "Custom Views", href: "/features#studio" },
      { title: "Report Scheduling", href: "/features#studio" },
    ],
  },
  {
    category: "AI-Powered",
    icon: Bot,
    color: "text-pink-400",
    items: [
      { title: "AI Financial Assistant", href: "/features#ai" },
      { title: "Smart Insights", href: "/features#ai" },
      { title: "Auto-Categorization", href: "/features#ai" },
      { title: "Predictive Analytics", href: "/features#ai" },
    ],
  },
  {
    category: "Team & Organization",
    icon: Users,
    color: "text-indigo-400",
    items: [
      { title: "Multi-Organization", href: "/features#team" },
      { title: "Role-Based Permissions", href: "/features#team" },
      { title: "Audit Logs", href: "/features#team" },
      { title: "Multi-Currency", href: "/features#team" },
    ],
  },
];

const solutionsData = [
  {
    title: "For Freelancers",
    description: "Simple invoicing and expense tracking for independent professionals",
    icon: UserCheck,
    href: "/signup",
  },
  {
    title: "For Small Business",
    description: "Complete accounting solution for growing businesses",
    icon: Building2,
    href: "/signup",
  },
  {
    title: "For Retail & Supermarkets",
    description: "Enterprise POS with offline mode, loyalty, and hardware integration",
    icon: ShoppingCart,
    href: "/signup",
  },
  {
    title: "For Restaurants & Cafes",
    description: "Table management, kitchen display, and course firing",
    icon: Utensils,
    href: "/signup",
  },
  {
    title: "For Accountants",
    description: "Manage multiple clients with powerful reporting tools",
    icon: Briefcase,
    href: "/signup",
  },
  {
    title: "For Enterprises",
    description: "Multi-organization support with subscription management",
    icon: Building,
    href: "/signup",
  },
  {
    title: "For Project Teams",
    description: "Task tracking, timesheets, and project billing",
    icon: FolderKanban,
    href: "/signup",
  },
  {
    title: "For HR & Operations",
    description: "Leave management, timesheets, and employee tracking",
    icon: Users,
    href: "/signup",
  },
];

const resourcesData = [
  {
    title: "Help Center",
    description: "Get answers to your questions",
    icon: HelpCircle,
    href: "/help",
  },
  {
    title: "Documentation",
    description: "Learn how to use AccrualFlow",
    icon: BookOpen,
    href: "/docs",
  },
  {
    title: "Contact Us",
    description: "Reach out to our support team",
    icon: Mail,
    href: "/contact",
  },
];

export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const ThemeButton = () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="text-white/70 hover:text-white hover:bg-white/10">
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-slate-900/98 backdrop-blur-xl border-white/10">
        <DropdownMenuItem 
          onClick={() => setTheme("light")}
          className={cn("text-white/70 hover:text-white hover:bg-white/10", theme === "light" && "bg-white/10")}
        >
          <Sun className="mr-2 h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem 
          onClick={() => setTheme("dark")}
          className={cn("text-white/70 hover:text-white hover:bg-white/10", theme === "dark" && "bg-white/10")}
        >
          <Moon className="mr-2 h-4 w-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem 
          onClick={() => setTheme("system")}
          className={cn("text-white/70 hover:text-white hover:bg-white/10", theme === "system" && "bg-white/10")}
        >
          <Monitor className="mr-2 h-4 w-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className={cn(
        "fixed top-0 left-0 right-0 z-50 transition-all duration-300",
        scrolled
          ? "bg-slate-900/95 backdrop-blur-md border-b border-white/10 shadow-lg"
          : "bg-transparent"
      )}
    >
      <div className="container mx-auto px-4">
        <nav className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <div className="h-9 w-9 md:h-10 md:w-10 rounded-xl bg-gradient-to-br from-purple-500 to-cyan-500 flex items-center justify-center">
              <FileText className="h-5 w-5 md:h-6 md:w-6 text-white" />
            </div>
            <span className="text-xl md:text-2xl font-bold text-white">AccrualFlow</span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex items-center gap-1 landing-nav">
            <NavigationMenu>
              <NavigationMenuList>
                {/* Features Dropdown */}
                <NavigationMenuItem>
                  <NavigationMenuTrigger className="bg-transparent text-white/70 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10">
                    Features
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <div className="w-[900px] max-h-[80vh] overflow-y-auto p-6 bg-slate-900/98 backdrop-blur-xl border border-white/10 rounded-xl">
                      <div className="grid grid-cols-5 gap-6">
                        {featuresData.map((category) => (
                          <div key={category.category} className="space-y-2">
                            <Link 
                              to={category.items[0]?.href || "/features"} 
                              className="flex items-center gap-2 group"
                            >
                              <category.icon className={cn("h-4 w-4", category.color)} />
                              <span className="font-semibold text-white text-xs group-hover:text-purple-300 transition-colors">
                                {category.category}
                              </span>
                            </Link>
                            <ul className="space-y-1">
                              {category.items.slice(0, 3).map((item) => (
                                <li key={item.title}>
                                  <NavigationMenuLink asChild>
                                    <Link
                                      to={item.href}
                                      className="block text-xs text-white/60 hover:text-white transition-colors py-0.5 hover:translate-x-0.5 transition-transform"
                                    >
                                      {item.title}
                                    </Link>
                                  </NavigationMenuLink>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 pt-4 border-t border-white/10">
                        <Link
                          to="/features"
                          className="inline-flex items-center gap-2 text-sm text-purple-400 hover:text-purple-300 transition-colors"
                        >
                          Explore all 15 feature categories
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </div>
                    </div>
                  </NavigationMenuContent>
                </NavigationMenuItem>

                {/* Solutions Dropdown */}
                <NavigationMenuItem>
                  <NavigationMenuTrigger className="bg-transparent text-white/70 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10">
                    Solutions
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <div className="w-[500px] p-6 bg-slate-900/98 backdrop-blur-xl border border-white/10 rounded-xl">
                      <div className="grid grid-cols-2 gap-4">
                        {solutionsData.map((solution) => (
                          <NavigationMenuLink key={solution.title} asChild>
                            <Link
                              to={solution.href}
                              className="flex items-start gap-3 p-3 rounded-lg hover:bg-white/5 transition-colors group"
                            >
                              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-purple-500/20 to-cyan-500/20 flex items-center justify-center shrink-0 group-hover:from-purple-500/30 group-hover:to-cyan-500/30 transition-colors">
                                <solution.icon className="h-5 w-5 text-purple-400" />
                              </div>
                              <div>
                                <p className="font-medium text-white text-sm">{solution.title}</p>
                                <p className="text-xs text-white/50 mt-0.5">{solution.description}</p>
                              </div>
                            </Link>
                          </NavigationMenuLink>
                        ))}
                      </div>
                    </div>
                  </NavigationMenuContent>
                </NavigationMenuItem>

                {/* Resources Dropdown */}
                <NavigationMenuItem>
                  <NavigationMenuTrigger className="bg-transparent text-white/70 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10">
                    Resources
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <div className="w-[350px] p-4 bg-slate-900/98 backdrop-blur-xl border border-white/10 rounded-xl">
                      <div className="space-y-2">
                        {resourcesData.map((resource) => (
                          <NavigationMenuLink key={resource.title} asChild>
                            <Link
                              to={resource.href}
                              className="flex items-center gap-3 p-3 rounded-lg hover:bg-white/5 transition-colors"
                            >
                              <resource.icon className="h-5 w-5 text-cyan-400" />
                              <div>
                                <p className="font-medium text-white text-sm">{resource.title}</p>
                                <p className="text-xs text-white/50">{resource.description}</p>
                              </div>
                            </Link>
                          </NavigationMenuLink>
                        ))}
                      </div>
                    </div>
                  </NavigationMenuContent>
                </NavigationMenuItem>

                {/* All Features Link */}
                <NavigationMenuItem>
                  <Link
                    to="/features"
                    className="px-4 py-2 text-white/70 hover:text-white transition-colors text-sm font-medium"
                  >
                    All Features
                  </Link>
                </NavigationMenuItem>

                {/* Pricing Link */}
                <NavigationMenuItem>
                  <a
                    href="#pricing"
                    className="px-4 py-2 text-white/70 hover:text-white transition-colors text-sm font-medium"
                  >
                    Pricing
                  </a>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>
          </div>

          {/* Desktop CTA Buttons */}
          <div className="hidden lg:flex items-center gap-2">
            <ThemeButton />
            {user ? (
              <Button
                className="bg-gradient-to-r from-purple-500 to-cyan-500 hover:from-purple-600 hover:to-cyan-600 text-white border-0"
                asChild
              >
                <Link to="/dashboard">Go to Dashboard</Link>
              </Button>
            ) : (
              <>
                <InstallAppButton
                  variant="ghost"
                  className="text-white hover:bg-white/10 border border-white/20"
                />
                <Button variant="ghost" className="text-white hover:bg-white/10" asChild>
                  <Link to="/login">Sign In</Link>
                </Button>
                <Button
                  className="bg-gradient-to-r from-purple-500 to-cyan-500 hover:from-purple-600 hover:to-cyan-600 text-white border-0"
                  asChild
                >
                  <Link to="/signup">Get Started Free</Link>
                </Button>
              </>
            )}
          </div>

          {/* Mobile Menu Button */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild className="lg:hidden">
              <Button variant="ghost" size="icon" className="text-white hover:bg-white/10">
                <Menu className="h-6 w-6" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:w-[400px] bg-slate-900 border-white/10 p-0">
              <SheetHeader className="p-6 border-b border-white/10">
                <SheetTitle className="text-white flex items-center gap-2">
                  <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-purple-500 to-cyan-500 flex items-center justify-center">
                    <FileText className="h-4 w-4 text-white" />
                  </div>
                  AccrualFlow
                </SheetTitle>
              </SheetHeader>
              
              <div className="p-6 space-y-4 overflow-y-auto max-h-[calc(100vh-180px)]">
                {/* All Features Direct Link */}
                <Link
                  to="/features"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center justify-between w-full py-2 text-white font-medium hover:text-purple-400 transition-colors"
                >
                  Explore All Features
                  <ArrowRight className="h-4 w-4 text-purple-400" />
                </Link>

                {/* Features Collapsible */}
                <Collapsible>
                  <CollapsibleTrigger className="flex items-center justify-between w-full py-2 text-white font-medium">
                    Features
                    <ChevronDown className="h-4 w-4 text-white/60" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-2 space-y-4">
                    {featuresData.map((category) => (
                      <div key={category.category} className="pl-4">
                        <div className="flex items-center gap-2 mb-2">
                          <category.icon className={cn("h-4 w-4", category.color)} />
                          <span className="text-sm font-medium text-white/80">{category.category}</span>
                        </div>
                        <ul className="space-y-2 pl-6">
                          {category.items.map((item) => (
                            <li key={item.title}>
                              <Link
                                to={item.href}
                                onClick={() => setMobileOpen(false)}
                                className="text-sm text-white/60 hover:text-white transition-colors"
                              >
                                {item.title}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </CollapsibleContent>
                </Collapsible>

                {/* Solutions Collapsible */}
                <Collapsible>
                  <CollapsibleTrigger className="flex items-center justify-between w-full py-2 text-white font-medium">
                    Solutions
                    <ChevronDown className="h-4 w-4 text-white/60" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-2 pl-4 space-y-3">
                    {solutionsData.map((solution) => (
                      <Link
                        key={solution.title}
                        to={solution.href}
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 py-2"
                      >
                        <solution.icon className="h-4 w-4 text-purple-400" />
                        <span className="text-sm text-white/70 hover:text-white transition-colors">
                          {solution.title}
                        </span>
                      </Link>
                    ))}
                  </CollapsibleContent>
                </Collapsible>

                {/* Resources Collapsible */}
                <Collapsible>
                  <CollapsibleTrigger className="flex items-center justify-between w-full py-2 text-white font-medium">
                    Resources
                    <ChevronDown className="h-4 w-4 text-white/60" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-2 pl-4 space-y-3">
                    {resourcesData.map((resource) => (
                      <Link
                        key={resource.title}
                        to={resource.href}
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 py-2"
                      >
                        <resource.icon className="h-4 w-4 text-cyan-400" />
                        <span className="text-sm text-white/70 hover:text-white transition-colors">
                          {resource.title}
                        </span>
                      </Link>
                    ))}
                  </CollapsibleContent>
                </Collapsible>

                {/* Pricing Link */}
                <a
                  href="#pricing"
                  onClick={() => setMobileOpen(false)}
                  className="block py-2 text-white font-medium"
                >
                  Pricing
                </a>

                {/* Theme Toggle */}
                <div className="flex items-center justify-between py-2 border-t border-white/10 mt-2 pt-4">
                  <span className="text-white font-medium">Theme</span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setTheme("light")}
                      className={cn("h-8 w-8 text-white/70 hover:text-white hover:bg-white/10", theme === "light" && "bg-white/10")}
                    >
                      <Sun className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setTheme("dark")}
                      className={cn("h-8 w-8 text-white/70 hover:text-white hover:bg-white/10", theme === "dark" && "bg-white/10")}
                    >
                      <Moon className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setTheme("system")}
                      className={cn("h-8 w-8 text-white/70 hover:text-white hover:bg-white/10", theme === "system" && "bg-white/10")}
                    >
                      <Monitor className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Mobile CTA Buttons */}
              <div className="absolute bottom-0 left-0 right-0 p-6 border-t border-white/10 bg-slate-900 space-y-3">
                {user ? (
                  <Button
                    className="w-full bg-gradient-to-r from-purple-500 to-cyan-500 hover:from-purple-600 hover:to-cyan-600 text-white border-0"
                    asChild
                  >
                    <Link to="/dashboard" onClick={() => setMobileOpen(false)}>
                      Go to Dashboard
                    </Link>
                  </Button>
                ) : (
                  <>
                    <Button
                      className="w-full bg-gradient-to-r from-purple-500 to-cyan-500 hover:from-purple-600 hover:to-cyan-600 text-white border-0"
                      asChild
                    >
                      <Link to="/signup" onClick={() => setMobileOpen(false)}>
                        Get Started Free
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full border border-white/20 text-white hover:bg-white/10 hover:text-white"
                      asChild
                    >
                      <Link to="/login" onClick={() => setMobileOpen(false)}>
                        Sign In
                      </Link>
                    </Button>
                    <InstallAppButton
                      variant="ghost"
                      className="w-full border border-white/20 text-white hover:bg-white/10 hover:text-white justify-center"
                    />
                  </>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </nav>
      </div>
    </motion.header>
  );
}
