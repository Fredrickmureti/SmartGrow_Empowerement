/**
 * DashboardSetupGuide — promoted, action-oriented setup card for new
 * tenants. Replaces a wall of zeroed widgets with concrete "Add your
 * first X" CTAs that route to the right module. Only rendered when
 * `useDashboardComposition().isNewTenant` is true; OnboardingChecklist
 * still covers fine-grained progress below.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, FileText, ArrowRight, Sparkles, BookOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { DashboardComposition } from "@/hooks/useDashboardComposition";

interface SetupItem {
  key: DashboardComposition["setupGaps"][number];
  title: string;
  description: string;
  cta: string;
  href: string;
  icon: React.ElementType;
}

const ITEMS: Record<DashboardComposition["setupGaps"][number], SetupItem> = {
  bank: {
    key: "bank",
    title: "Connect your first bank account",
    description: "Track balances, import statements, and reconcile transactions.",
    cta: "Add bank account",
    href: "/finance/banking",
    icon: Building2,
  },
  clients: {
    key: "clients",
    title: "Register your first client",
    description: "Clients are the borrowers your officers manage and lend to.",
    cta: "Add client",
    href: "/lending/clients",
    icon: FileText,
  },
  coa: {
    key: "coa",
    title: "Set up your chart of accounts",
    description: "Install a localization pack so journal entries can post correctly.",
    cta: "Open accounts",
    href: "/finance/accounts",
    icon: BookOpen,
  },
};

export function DashboardSetupGuide({ gaps }: { gaps: DashboardComposition["setupGaps"] }) {
  const navigate = useNavigate();
  if (gaps.length === 0) return null;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <CardTitle className="text-base sm:text-lg">Finish setting up your workspace</CardTitle>
        </div>
        <CardDescription>
          A few quick steps will turn this dashboard into a live picture of your business.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {gaps.map((g) => {
          const item = ITEMS[g];
          const Icon = item.icon;
          return (
            <div
              key={item.key}
              className="flex flex-col gap-2 rounded-lg border bg-card p-3 sm:p-4"
            >
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <p className="text-sm font-semibold leading-tight">{item.title}</p>
              </div>
              <p className="text-xs text-muted-foreground">{item.description}</p>
              <Button
                size="sm"
                className="mt-1 w-full"
                onClick={() => navigate(item.href)}
              >
                {item.cta}
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}