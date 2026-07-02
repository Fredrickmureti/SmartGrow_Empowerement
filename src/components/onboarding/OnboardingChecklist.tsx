import { useState, useEffect } from "react";
import { OpeningBalanceWizard } from "@/components/onboarding/OpeningBalanceWizard";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { 
  CheckCircle2, 
  Circle, 
  Users, 
  FileText, 
  Landmark,
  DollarSign,
  Receipt, 
  Image, 
  ChevronRight,
  X,
  Sparkles,
  Trophy,
  PartyPopper
} from "lucide-react";
import { useContacts } from "@/hooks/useContacts";
import { useInvoices } from "@/hooks/useInvoices";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useExpenses } from "@/hooks/useExpenses";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { cn } from "@/lib/utils";

interface ChecklistItem {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  href?: string;
  onClick?: () => void;
  completed: boolean;
  priority: number;
}

interface OnboardingChecklistProps {
  variant?: "card" | "compact" | "banner";
  className?: string;
}

export function OnboardingChecklist({ variant = "card", className }: OnboardingChecklistProps) {
  const navigate = useNavigate();
  const [isDismissed, setIsDismissed] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [showOBWizard, setShowOBWizard] = useState(false);
  const { contacts } = useContacts();
  const { invoices } = useInvoices();
  const { accounts: bankAccounts } = useBankAccounts();
  const { expenses } = useExpenses();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Check localStorage for dismissed state
  useEffect(() => {
    const dismissed = localStorage.getItem("onboardingDismissed");
    if (dismissed === "true") {
      setIsDismissed(true);
    }
  }, []);

  const handleDismiss = () => {
    setIsDismissed(true);
    localStorage.setItem("onboardingDismissed", "true");
  };

  const checklistItems: ChecklistItem[] = [
    {
      id: "add-customer",
      title: "Add your first customer",
      description: "Create a contact to start invoicing",
      icon: Users,
      href: "/contacts",
      completed: (contacts?.length || 0) > 0,
      priority: 1,
    },
    {
      id: "create-invoice",
      title: "Create your first invoice",
      description: "Send a professional invoice to get paid",
      icon: FileText,
      href: "/invoices",
      completed: (invoices?.length || 0) > 0,
      priority: 2,
    },
    {
      id: "connect-bank",
      title: "Connect a bank account",
      description: "Track your cash flow automatically",
      icon: Landmark,
      href: "/banking",
      completed: (bankAccounts?.length || 0) > 0,
      priority: 3,
    },
    {
      id: "add-expense",
      title: "Record an expense",
      description: "Track your business spending",
      icon: Receipt,
      href: "/expenses",
      completed: (expenses?.length || 0) > 0,
      priority: 4,
    },
    {
      id: "set-opening-balances",
      title: "Set opening balances",
      description: "Enter your starting account balances",
      icon: DollarSign,
      onClick: () => setShowOBWizard(true),
      completed: false, // Users can always re-run
      priority: 5,
    },
    {
      id: "upload-logo",
      title: "Upload your company logo",
      description: "Brands invoices, bills, receipts and statements",
      icon: Image,
      href: "/settings/company?tab=company",
      // Per-company logo (Odoo res.company). Workspace logo is deprecated.
      completed: !!currentBusiness?.logo_url,
      priority: 6,
    },
  ];

  const completedCount = checklistItems.filter((item) => item.completed).length;
  const progress = (completedCount / checklistItems.length) * 100;
  const isAllComplete = completedCount === checklistItems.length;

  // Show celebration when all items complete
  useEffect(() => {
    if (isAllComplete && !isDismissed) {
      setShowCelebration(true);
      const timer = setTimeout(() => {
        setShowCelebration(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [isAllComplete, isDismissed]);

  // Don't show if dismissed or all items completed (after celebration)
  if (isDismissed) {
    return null;
  }

  // Sort items: incomplete first, then by priority
  const sortedItems = [...checklistItems].sort((a, b) => {
    if (a.completed !== b.completed) {
      return a.completed ? 1 : -1;
    }
    return a.priority - b.priority;
  });

  // Get next action
  const nextAction = sortedItems.find(item => !item.completed);

  if (variant === "banner") {
    return (
      <div className={cn(
        "relative overflow-hidden rounded-lg border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-4",
        className
      )}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-medium">
                {isAllComplete 
                  ? "🎉 Setup complete!" 
                  : `${completedCount}/${checklistItems.length} setup tasks complete`}
              </p>
              {nextAction && (
                <p className="text-sm text-muted-foreground">
                  Next: {nextAction.title}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Progress value={progress} className="w-24 h-2" />
            {nextAction && (
              <Button size="sm" onClick={() => nextAction.onClick ? nextAction.onClick() : navigate(nextAction.href || "/")}>
                Continue
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleDismiss}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className={cn("space-y-3", className)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Setup Progress</span>
          </div>
          <Badge variant="secondary" className="text-xs">
            {completedCount}/{checklistItems.length}
          </Badge>
        </div>
        <Progress value={progress} className="h-2" />
        {nextAction && (
          <Button 
            variant="outline" 
            size="sm" 
            className="w-full justify-between"
            onClick={() => navigate(nextAction.href)}
          >
            <span className="flex items-center gap-2">
              <nextAction.icon className="h-4 w-4 text-primary" />
              {nextAction.title}
            </span>
            <ChevronRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  }

  // Default card variant
  return (
    <>
    <Card className={cn(
      "border-primary/20 bg-gradient-to-br from-primary/5 to-transparent relative overflow-hidden",
      className
    )}>
      {/* Celebration overlay */}
      {showCelebration && (
        <div className="absolute inset-0 bg-gradient-to-r from-success/20 to-primary/20 flex items-center justify-center z-10">
          <div className="text-center">
            <PartyPopper className="h-12 w-12 text-success mx-auto mb-2 animate-bounce" />
            <p className="font-bold text-lg">Congratulations!</p>
            <p className="text-sm text-muted-foreground">You've completed all setup tasks</p>
          </div>
        </div>
      )}

      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              {isAllComplete ? (
                <Trophy className="h-4 w-4 text-success" />
              ) : (
                <Sparkles className="h-4 w-4 text-primary" />
              )}
            </div>
            <div>
              <CardTitle className="text-lg">
                {isAllComplete ? "Setup Complete!" : "Get Started"}
              </CardTitle>
              <CardDescription>
                {isAllComplete 
                  ? "You're all set up and ready to go"
                  : "Complete these steps to set up your account"}
              </CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleDismiss}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-3 pt-2">
          <Progress value={progress} className="flex-1 h-2" />
          <Badge variant={isAllComplete ? "default" : "secondary"} className="text-xs">
            {completedCount}/{checklistItems.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-2">
          {sortedItems.map((item) => (
            <button
              key={item.id}
              onClick={() => item.onClick ? item.onClick() : navigate(item.href || "/")}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left group",
                item.completed 
                  ? "bg-success/5 hover:bg-success/10" 
                  : "hover:bg-secondary/50"
              )}
            >
              {item.completed ? (
                <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
              ) : (
                <Circle className="h-5 w-5 text-muted-foreground shrink-0 group-hover:text-primary transition-colors" />
              )}
              <item.icon className={cn(
                "h-4 w-4 shrink-0",
                item.completed ? "text-success/70" : "text-primary"
              )} />
              <div className="flex-1 min-w-0">
                <p className={cn(
                  "text-sm font-medium",
                  item.completed && "text-muted-foreground line-through"
                )}>
                  {item.title}
                </p>
                <p className="text-xs text-muted-foreground truncate">{item.description}</p>
              </div>
              <ChevronRight className={cn(
                "h-4 w-4 text-muted-foreground transition-opacity",
                item.completed ? "opacity-50" : "opacity-0 group-hover:opacity-100"
              )} />
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
    <OpeningBalanceWizard open={showOBWizard} onOpenChange={setShowOBWizard} />
    </>
  );
}
