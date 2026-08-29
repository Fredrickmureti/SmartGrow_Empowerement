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
  Store,
  Users,
  Sprout,
  PiggyBank,
  GraduationCap,
  ShieldCheck,
  HelpCircle,
  BookOpen,
  Mail,
  Menu,
  ChevronDown,
  ArrowRight,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";

/** Loan and savings products offered to members. */
const productsData = [
  {
    title: "Business loans",
    description: "Working capital for stock, equipment or premises",
    icon: Store,
    href: "/features#business-loans",
  },
  {
    title: "Group lending",
    description: "Joint-liability credit for savings groups",
    icon: Users,
    href: "/features#group-lending",
  },
  {
    title: "Agriculture credit",
    description: "Input financing repaid after harvest",
    icon: Sprout,
    href: "/features#agriculture",
  },
  {
    title: "Savings",
    description: "Voluntary and compulsory member savings",
    icon: PiggyBank,
    href: "/features#savings",
  },
  {
    title: "Business training",
    description: "Free record keeping and pricing clinics",
    icon: GraduationCap,
    href: "/features#training",
  },
  {
    title: "Member protection",
    description: "Clear pricing, fair recovery, credit-life cover",
    icon: ShieldCheck,
    href: "/features#protection",
  },
];

const resourcesData = [
  {
    title: "Help centre",
    description: "Answers to common member questions",
    icon: HelpCircle,
    href: "/help",
  },
  {
    title: "About us",
    description: `Who ${BRAND.shortName} serves and why`,
    icon: BookOpen,
    href: "/about",
  },
  {
    title: "Contact a branch",
    description: "Talk to a loan officer near you",
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
            <span className="flex h-9 w-9 md:h-10 md:w-10 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
              {BRAND.initials}
            </span>
            <span className="text-lg md:text-xl font-bold text-white">{BRAND.name}</span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex items-center gap-1 landing-nav">
            <NavigationMenu>
              <NavigationMenuList>
                {/* Products Dropdown */}
                <NavigationMenuItem>
                  <NavigationMenuTrigger className="bg-transparent text-white/70 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10">
                    Loans &amp; savings
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <div className="w-[520px] p-6 bg-slate-900/98 backdrop-blur-xl border border-white/10 rounded-xl">
                      <div className="grid grid-cols-2 gap-3">
                        {productsData.map((product) => (
                          <NavigationMenuLink key={product.title} asChild>
                            <Link
                              to={product.href}
                              className="flex items-start gap-3 p-3 rounded-lg hover:bg-white/5 transition-colors"
                            >
                              <product.icon className="h-4 w-4 mt-0.5 text-emerald-400" />
                              <span>
                                <span className="block text-sm font-medium text-white">
                                  {product.title}
                                </span>
                                <span className="block text-xs text-white/60">
                                  {product.description}
                                </span>
                              </span>
                            </Link>
                          </NavigationMenuLink>
                        ))}
                      </div>
                      <div className="mt-4 pt-4 border-t border-white/10">
                        <Link
                          to="/features"
                          className="inline-flex items-center gap-2 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                          See all products and terms
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </div>
                    </div>
                  </NavigationMenuContent>
                </NavigationMenuItem>

                {/* Resources Dropdown */}
                <NavigationMenuItem>
                  <NavigationMenuTrigger className="bg-transparent text-white/70 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10">
                    Members
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <div className="w-[420px] p-6 bg-slate-900/98 backdrop-blur-xl border border-white/10 rounded-xl space-y-2">
                      {resourcesData.map((resource) => (
                        <NavigationMenuLink key={resource.title} asChild>
                          <Link
                            to={resource.href}
                            className="flex items-start gap-3 p-3 rounded-lg hover:bg-white/5 transition-colors"
                          >
                            <resource.icon className="h-4 w-4 mt-0.5 text-cyan-400" />
                            <span>
                              <span className="block text-sm font-medium text-white">
                                {resource.title}
                              </span>
                              <span className="block text-xs text-white/60">
                                {resource.description}
                              </span>
                            </span>
                          </Link>
                        </NavigationMenuLink>
                      ))}
                    </div>
                  </NavigationMenuContent>
                </NavigationMenuItem>

                <NavigationMenuItem>
                  <a
                    href="/#how-it-works"
                    className="px-4 py-2 text-white/70 hover:text-white transition-colors text-sm font-medium"
                  >
                    How it works
                  </a>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>
          </div>

          {/* Desktop CTA Buttons */}
          <div className="hidden lg:flex items-center gap-2">
            <ThemeButton />
            {user ? (
              <Button asChild>
                <Link to="/dashboard">Go to dashboard</Link>
              </Button>
            ) : (
              <>
                <Button variant="ghost" className="text-white hover:bg-white/10" asChild>
                  <Link to="/login">Staff sign in</Link>
                </Button>
                <Button asChild>
                  <Link to="/contact">Apply for a loan</Link>
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
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                    {BRAND.initials}
                  </span>
                  {BRAND.name}
                </SheetTitle>
              </SheetHeader>

              <div className="p-6 space-y-4 overflow-y-auto max-h-[calc(100vh-180px)]">
                <Link
                  to="/features"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center justify-between w-full py-2 text-white font-medium hover:text-emerald-400 transition-colors"
                >
                  All products
                  <ArrowRight className="h-4 w-4 text-emerald-400" />
                </Link>

                <Collapsible>
                  <CollapsibleTrigger className="flex items-center justify-between w-full py-2 text-white font-medium">
                    Loans &amp; savings
                    <ChevronDown className="h-4 w-4 text-white/60" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-2 pl-4 space-y-3">
                    {productsData.map((product) => (
                      <Link
                        key={product.title}
                        to={product.href}
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 py-2"
                      >
                        <product.icon className="h-4 w-4 text-emerald-400" />
                        <span className="text-sm text-white/70 hover:text-white transition-colors">
                          {product.title}
                        </span>
                      </Link>
                    ))}
                  </CollapsibleContent>
                </Collapsible>

                <Collapsible>
                  <CollapsibleTrigger className="flex items-center justify-between w-full py-2 text-white font-medium">
                    Members
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

                <a
                  href="/#how-it-works"
                  onClick={() => setMobileOpen(false)}
                  className="block py-2 text-white font-medium"
                >
                  How it works
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
                  <Button className="w-full" asChild>
                    <Link to="/dashboard" onClick={() => setMobileOpen(false)}>
                      Go to dashboard
                    </Link>
                  </Button>
                ) : (
                  <>
                    <Button className="w-full" asChild>
                      <Link to="/contact" onClick={() => setMobileOpen(false)}>
                        Apply for a loan
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full text-white hover:bg-white/10"
                      asChild
                    >
                      <Link to="/login" onClick={() => setMobileOpen(false)}>
                        Staff sign in
                      </Link>
                    </Button>
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
