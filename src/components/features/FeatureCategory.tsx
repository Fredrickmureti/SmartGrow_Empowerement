import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { LucideIcon, ArrowRight } from "lucide-react";
import { FeatureCard } from "./FeatureCard";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
}

interface Category {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  color: string;
  image?: string;
  imageAlt?: string;
  features: Feature[];
}

interface FeatureCategoryProps {
  category: Category;
  index: number;
}

// Map category IDs to dashboard routes
const categoryRouteMap: Record<string, string> = {
  invoicing: "/dashboard/invoices",
  accounting: "/dashboard/expenses",
  reports: "/dashboard/reports",
  sales: "/dashboard/sales-orders",
  inventory: "/dashboard/inventory",
  pos: "/dashboard/pos",
  ai: "/dashboard",
  team: "/dashboard/settings",
};

export function FeatureCategory({ category, index }: FeatureCategoryProps) {
  const isEven = index % 2 === 0;
  const Icon = category.icon;
  const navigate = useNavigate();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setIsAuthenticated(!!session);
    };
    
    checkAuth();
    
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setIsAuthenticated(!!session);
    });
    
    return () => subscription.unsubscribe();
  }, []);

  const handleTryIt = () => {
    if (isAuthenticated) {
      const route = categoryRouteMap[category.id] || "/dashboard";
      navigate(route);
    } else {
      navigate("/signup");
    }
  };

  return (
    <section
      id={category.id}
      className="py-20 md:py-28 relative overflow-hidden"
    >
      {/* Background for alternating sections */}
      {!isEven && (
        <div className="absolute inset-0 bg-muted/30" />
      )}

      <div className="container mx-auto px-4 relative z-10">
        <div className={cn(
          "grid lg:grid-cols-2 gap-12 lg:gap-16 items-center",
          !isEven && "lg:grid-flow-col-dense"
        )}>
          {/* Content Side */}
          <motion.div
            initial={{ opacity: 0, x: isEven ? -30 : 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
            className={cn(!isEven && "lg:col-start-2")}
          >
            {/* Category Header */}
            <div className="flex items-center gap-3 mb-4">
              <div className={cn(
                "h-12 w-12 rounded-xl bg-gradient-to-br flex items-center justify-center text-white",
                category.color
              )}>
                <Icon className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-2xl md:text-3xl font-bold text-foreground">
                  {category.title}
                </h2>
              </div>
            </div>

            <p className="text-lg text-muted-foreground mb-8">
              {category.description}
            </p>

            {/* Feature Cards Grid */}
            <div className="grid sm:grid-cols-2 gap-4">
              {category.features.map((feature, i) => (
                <FeatureCard
                  key={feature.title}
                  feature={feature}
                  index={i}
                  categoryColor={category.color}
                />
              ))}
            </div>

            {/* Try It Out Button */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="mt-8"
            >
              <Button
                onClick={handleTryIt}
                className={cn(
                  "group bg-gradient-to-r text-white font-semibold px-6 py-3 h-auto",
                  category.color,
                  "hover:shadow-lg transition-all duration-300"
                )}
              >
                {isAuthenticated ? `Try ${category.title}` : "Get Started Free"}
                <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
              </Button>
            </motion.div>
          </motion.div>

          {/* Image Side */}
          <motion.div
            initial={{ opacity: 0, x: isEven ? 30 : -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className={cn(!isEven && "lg:col-start-1")}
          >
            {category.image ? (
              <div className="relative rounded-2xl overflow-hidden border border-border shadow-2xl">
                <img
                  src={category.image}
                  alt={category.imageAlt || category.title}
                  className="w-full h-auto"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-background/60 to-transparent" />
              </div>
            ) : (
              /* Placeholder visual when no image */
              <div className="relative rounded-2xl overflow-hidden border border-border bg-gradient-to-br from-muted to-muted/50 aspect-video flex items-center justify-center">
                <div className={cn(
                  "h-24 w-24 rounded-2xl bg-gradient-to-br flex items-center justify-center opacity-30 text-white",
                  category.color
                )}>
                  <Icon className="h-12 w-12" />
                </div>
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,hsl(var(--background)/0.4)_100%)]" />
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </section>
  );
}
