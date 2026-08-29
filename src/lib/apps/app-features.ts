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
  hr: {
    tagline: "People Operations",
    headline: "One directory for your whole institution",
    description: "Maintain staff records, reporting lines, branches and org structure — the people foundation the rest of the platform authorises against.",
    features: [
      {
        icon: Users,
        title: "Employee Directory",
        description: "Centralized staff profiles with org charts and reporting lines.",
      },
      {
        icon: Shield,
        title: "Role & Branch Assignment",
        description: "Tie every officer to a branch and a role so access follows the org chart.",
      },
      {
        icon: BarChart3,
        title: "Org Structure",
        description: "Departments, positions and locations kept in one authoritative place.",
      },
      {
        icon: CheckCircle,
        title: "Audit Ready",
        description: "Every change to a staff record is recorded with who and when.",
      },
    ],
    benefits: [
      { text: "One authoritative staff register" },
      { text: "Access that follows the org chart" },
      { text: "Clean branch and officer assignment" },
      { text: "Complete change history" },
    ],
    ctaText: "Start Now — It's Free",
    secondaryCtaText: "Learn More",
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
