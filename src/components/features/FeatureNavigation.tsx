import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface Category {
  id: string;
  title: string;
  icon: LucideIcon;
  color: string;
}

interface FeatureNavigationProps {
  categories: Category[];
}

export function FeatureNavigation({ categories }: FeatureNavigationProps) {
  const [activeSection, setActiveSection] = useState<string>("");
  const [isSticky, setIsSticky] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const navOffset = 500;
      setIsSticky(window.scrollY > navOffset);

      const sections = categories.map((cat) => {
        const element = document.getElementById(cat.id);
        if (element) {
          const rect = element.getBoundingClientRect();
          return { id: cat.id, top: rect.top };
        }
        return null;
      }).filter(Boolean);

      const active = sections.find((section) => section && section.top > -200 && section.top < 400);
      if (active) {
        setActiveSection(active.id);
      }
    };

    window.addEventListener("scroll", handleScroll);
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, [categories]);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      const offset = 100;
      const top = element.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: "smooth" });
    }
  };

  return (
    <motion.nav
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.6, duration: 0.5 }}
      className={cn(
        "z-40 transition-all duration-300 py-4",
        isSticky
          ? "fixed top-16 md:top-20 left-0 right-0 bg-background/95 backdrop-blur-md border-b border-border shadow-lg"
          : "relative bg-transparent"
      )}
    >
      <div className="container mx-auto px-4">
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {categories.map((category) => {
            const Icon = category.icon;
            const isActive = activeSection === category.id;
            
            return (
              <button
                key={category.id}
                onClick={() => scrollToSection(category.id)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg whitespace-nowrap transition-all duration-200",
                  isActive
                    ? "bg-primary/10 border border-primary/30 text-foreground"
                    : "bg-muted/50 border border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                <Icon className={cn("h-4 w-4", isActive ? "text-primary" : "")} />
                <span className="text-sm font-medium">{category.title}</span>
              </button>
            );
          })}
        </div>
      </div>
    </motion.nav>
  );
}
