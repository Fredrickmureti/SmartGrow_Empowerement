import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { 
  Calculator, 
  BarChart3, 
  Package, 
  ShoppingCart, 
  Users, 
  Monitor, 
  Building2,
  ArrowRight,
  Zap,
} from "lucide-react";

const modules = [
  {
    icon: Calculator,
    title: "Finance & Accounting",
    description: "Double-entry accounting, chart of accounts, journal entries, bank reconciliation, budgets, and fixed assets.",
    color: "from-purple-500 to-purple-600",
  },
  {
    icon: ShoppingCart,
    title: "Sales & Invoicing",
    description: "Professional invoices, recurring billing, estimates, sales orders, delivery notes, and customer payments.",
    color: "from-cyan-500 to-cyan-600",
  },
  {
    icon: Package,
    title: "Inventory & Purchases",
    description: "Stock management, multi-warehouse, purchase orders, vendor bills, expense tracking, and replenishment.",
    color: "from-amber-500 to-amber-600",
  },
  {
    icon: Monitor,
    title: "Point of Sale",
    description: "Multi-register POS with floor plans, kitchen display, reservations, and hardware integration.",
    color: "from-green-500 to-green-600",
  },
  {
    icon: Users,
    title: "HR & Payroll",
    description: "Employee management, departments, leave tracking, payroll processing, attendance, and self-service portal.",
    color: "from-rose-500 to-rose-600",
  },
  {
    icon: BarChart3,
    title: "Reports & Analytics",
    description: "16+ report types — financial statements, aging, budgets, tax, audit trail, and business intelligence.",
    color: "from-indigo-500 to-indigo-600",
  },
  {
    icon: Building2,
    title: "CRM & Projects",
    description: "Sales pipeline, activities, contacts, project management, and timesheets — all in one place.",
    color: "from-teal-500 to-teal-600",
  },
  {
    icon: Zap,
    title: "Studio & Customization",
    description: "Custom fields, automations, form builders, report designers, and scheduled report delivery.",
    color: "from-orange-500 to-orange-600",
  },
];

export function FeaturesSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <section id="features" ref={ref} className="py-24 bg-background">
      <div className="container mx-auto px-4">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="text-center max-w-3xl mx-auto mb-16"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Everything You Need to{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-cyan-500">
              Run Your Business
            </span>
          </h2>
          <p className="text-lg text-muted-foreground">
            A complete ERP platform — finance, sales, inventory, POS, HR, CRM, and more — all connected in one system.
          </p>
        </motion.div>

        {/* Module Cards Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {modules.map((mod, index) => (
            <motion.div
              key={mod.title}
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.4, delay: 0.1 + index * 0.07 }}
              whileHover={{ y: -5 }}
              className="p-6 rounded-2xl border bg-card hover:shadow-lg transition-shadow"
            >
              <div className={`h-12 w-12 rounded-xl bg-gradient-to-r ${mod.color} flex items-center justify-center mb-4`}>
                <mod.icon className="h-6 w-6 text-white" />
              </div>
              <h4 className="text-lg font-semibold mb-2">{mod.title}</h4>
              <p className="text-sm text-muted-foreground">{mod.description}</p>
            </motion.div>
          ))}
        </div>

        {/* Explore All Features CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.8 }}
          className="mt-12 text-center"
        >
          <Button variant="outline" size="lg" asChild>
            <Link to="/features">
              Explore All Features
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </motion.div>
      </div>
    </section>
  );
}
