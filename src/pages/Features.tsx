import { LandingHeader } from "@/components/landing/LandingHeader";
import { FooterSection } from "@/components/landing/CTASection";
import { FeaturesHero } from "@/components/features/FeaturesHero";
import { FeatureCategory } from "@/components/features/FeatureCategory";
import { FeatureNavigation } from "@/components/features/FeatureNavigation";
import { FeaturesCTA } from "@/components/features/FeaturesCTA";
import {
  Store,
  Users,
  Sprout,
  PiggyBank,
  GraduationCap,
  ShieldCheck,
  Banknote,
  CalendarClock,
  Receipt,
  HandCoins,
  Handshake,
  ClipboardList,
  Tractor,
  CloudSun,
  Warehouse,
  Wallet,
  Lock,
  TrendingUp,
  BookOpen,
  Calculator,
  Target,
  FileText,
  Scale,
  HeartHandshake,
} from "lucide-react";

const productCategories = [
  {
    id: "business-loans",
    title: "Business loans",
    description:
      "Working capital and asset finance for small traders, kiosks, workshops and service businesses in our catchment.",
    icon: Store,
    color: "from-emerald-500 to-emerald-600",
    features: [
      {
        icon: Banknote,
        title: "KES 10,000 – 500,000",
        description:
          "First cycle starts small and grows with repayment history. No hidden ceiling for members in good standing.",
      },
      {
        icon: CalendarClock,
        title: "Weekly or monthly repayment",
        description:
          "Instalments are set against the cash flow your business actually produces, not a fixed office template.",
      },
      {
        icon: Receipt,
        title: "One disclosed rate",
        description:
          "Interest, appraisal fee and insurance are written on the offer letter before you sign. Nothing is added later.",
      },
      {
        icon: HandCoins,
        title: "Disbursement to mobile money",
        description:
          "Approved loans are paid out to your registered mobile wallet or bank account, with a receipt on the same day.",
      },
    ],
  },
  {
    id: "group-lending",
    title: "Group lending",
    description:
      "Joint-liability credit for savings groups of five to fifteen members who guarantee one another.",
    icon: Users,
    color: "from-sky-500 to-sky-600",
    features: [
      {
        icon: Handshake,
        title: "The group is the security",
        description:
          "No title deeds and no salaried guarantor required. Members appraise and back each other's loans.",
      },
      {
        icon: ClipboardList,
        title: "Weekly meetings",
        description:
          "Contributions, repayments and new applications are recorded in the open at the group meeting.",
      },
      {
        icon: TrendingUp,
        title: "Graduated cycles",
        description:
          "Every cleared cycle raises the group's limit, so reliable members reach larger amounts over time.",
      },
      {
        icon: Scale,
        title: "Shared responsibility, fair recovery",
        description:
          "Arrears are handled with the group first. Recovery follows a published, humane process.",
      },
    ],
  },
  {
    id: "agriculture",
    title: "Agriculture credit",
    description:
      "Input and equipment financing timed to the planting calendar, with repayment falling after harvest.",
    icon: Sprout,
    color: "from-lime-500 to-lime-600",
    features: [
      {
        icon: Tractor,
        title: "Input financing",
        description:
          "Seed, fertiliser and crop protection funded at the start of the season, disbursed directly or via stockists.",
      },
      {
        icon: CloudSun,
        title: "Season-aligned schedules",
        description:
          "Grace period through the growing season, with the bulk of repayment due once produce is sold.",
      },
      {
        icon: Warehouse,
        title: "Post-harvest support",
        description:
          "Short-term credit against stored produce so members are not forced to sell at the lowest price.",
      },
      {
        icon: ShieldCheck,
        title: "Weather-aware restructuring",
        description:
          "Where a season fails, schedules are restructured rather than penalised into default.",
      },
    ],
  },
  {
    id: "savings",
    title: "Savings",
    description:
      "Voluntary and compulsory member savings held safely at the branch, earning interest and building loan eligibility.",
    icon: PiggyBank,
    color: "from-cyan-500 to-cyan-600",
    features: [
      {
        icon: Wallet,
        title: "Voluntary savings",
        description:
          "Deposit any amount at the branch or by mobile money, withdraw at your branch during opening hours.",
      },
      {
        icon: Lock,
        title: "Compulsory savings",
        description:
          "A small share of each loan cycle is saved, building a cushion that is returned when the loan clears.",
      },
      {
        icon: TrendingUp,
        title: "Interest on balances",
        description:
          "Balances earn interest credited at the end of each period and shown on your member statement.",
      },
      {
        icon: FileText,
        title: "Statements on request",
        description:
          "Ask at any branch for a printed statement of contributions, interest and withdrawals.",
      },
    ],
  },
  {
    id: "training",
    title: "Business training",
    description:
      "Free clinics for borrowing members on the skills that decide whether a small business survives its first loan.",
    icon: GraduationCap,
    color: "from-amber-500 to-amber-600",
    features: [
      {
        icon: BookOpen,
        title: "Record keeping",
        description:
          "Simple daily books that separate business money from household money — the single biggest predictor of repayment.",
      },
      {
        icon: Calculator,
        title: "Pricing and margins",
        description:
          "Costing stock properly so that a busy shop is also a profitable one.",
      },
      {
        icon: Warehouse,
        title: "Stock control",
        description:
          "Ordering rhythms that keep cash free instead of locked in slow-moving stock.",
      },
      {
        icon: Target,
        title: "Growth planning",
        description:
          "Deciding what the next loan cycle should fund, and what it should not.",
      },
    ],
  },
  {
    id: "protection",
    title: "Member protection",
    description:
      "How we keep lending fair: clear pricing, credit-life cover and a recovery process members can hold us to.",
    icon: ShieldCheck,
    color: "from-slate-500 to-slate-600",
    features: [
      {
        icon: Receipt,
        title: "Full cost disclosure",
        description:
          "Total cost of credit is stated in shillings, not just percentages, before any signature.",
      },
      {
        icon: HeartHandshake,
        title: "Credit-life cover",
        description:
          "An outstanding balance is settled by cover in the event of a member's death, so families are not pursued.",
      },
      {
        icon: Scale,
        title: "Published recovery steps",
        description:
          "Reminders, group consultation and restructuring come before any enforcement action.",
      },
      {
        icon: ClipboardList,
        title: "Complaints you can track",
        description:
          "Every complaint is logged with a reference and answered by a named officer.",
      },
    ],
  },
];

const navigationCategories = productCategories.map((category) => ({
  id: category.id,
  title: category.title,
  icon: category.icon,
  color: category.color,
}));

export default function Features() {
  return (
    <div className="min-h-screen bg-background">
      <LandingHeader />
      <FeaturesHero />
      <FeatureNavigation categories={navigationCategories} />
      <div className="container mx-auto px-4">
        {productCategories.map((category, index) => (
          <FeatureCategory key={category.id} category={category} index={index} />
        ))}
      </div>
      <FeaturesCTA />
      <FooterSection />
    </div>
  );
}
