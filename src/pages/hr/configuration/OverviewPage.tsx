/**
 * Configuration overview — the single landing surface for /hr/configuration.
 *
 * Wave J: this is now the ONLY navigation surface (the duplicate sticky
 * sidebar was removed). Grouped cards, consistent typography, explicit
 * affordance for cards that leave the configuration shell vs cards that
 * navigate within it.
 */
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Building2, Briefcase, MapPin, Calendar, Shield, FileText,
  GraduationCap, ClipboardList, Sparkles, ScrollText, Wrench,
  ArrowRight, ExternalLink, Settings,
} from "lucide-react";

type Section = {
  to: string;
  external?: boolean;
  icon: any;
  title: string;
  text: string;
};

const GROUPS: { label: string; description?: string; items: Section[] }[] = [
  {
    label: "Organization",
    description: "How the company is structured.",
    items: [
      { to: "/hr/employees/departments",                  external: true,  icon: Building2,  title: "Departments",     text: "Hierarchy of departments with managers." },
      { to: "/hr/employees/positions",                external: true,  icon: Briefcase,  title: "Job positions",   text: "Standardize job titles across the company." },
      { to: "/hr/employees/locations",               external: true,  icon: MapPin,     title: "Work locations",  text: "Office, remote and hybrid sites." },
      { to: "/hr/leave/holidays", icon: Calendar, title: "Public holidays", text: "Calendar consumed by attendance and leave." },
    ],
  },
  {
    label: "Employee record",
    description: "Shape of the data captured on every employee.",
    items: [
      { to: "/hr/configuration/statutory-fields",    icon: Shield,        title: "Statutory fields",    text: "Tax and social-security IDs employees must provide." },
      { to: "/hr/configuration/document-categories", icon: FileText,      title: "Document categories", text: "Taxonomy for the employee file." },
      { to: "/hr/talent/competencies",        icon: GraduationCap, title: "Competencies",        text: "Skills catalog assigned to employees." },
    ],
  },
  {
    label: "Lifecycle",
    description: "Templates that drive onboarding, exits and benefits.",
    items: [
      { to: "/hr/configuration/onboarding-templates", icon: ClipboardList, title: "Onboarding templates", text: "Reusable checklists auto-applied to new hires." },
      { to: "/hr/benefit-windows",  external: true,   icon: Sparkles,      title: "Benefit windows",      text: "Open-enrollment periods gating benefit changes." },
    ],
  },
  {
    label: "Policies",
    description: "Business-wide defaults that pre-fill contracts and numbering.",
    items: [
      { to: "/hr/configuration/policies", icon: ScrollText, title: "HR defaults", text: "Probation, notice, leave year, employee number format." },
    ],
  },
];

const ADMIN: Section[] = [
  { to: "/hr/configuration/maintenance", icon: Wrench, title: "Maintenance", text: "Bulk operations and data-integrity checks." },
];

export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="page-title">HR Configuration</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Catalogs, templates, statutory rules and policies for the Employees app. Changes here apply to the whole company unless a branch override exists.
          </p>
        </div>
      </div>

      {GROUPS.map(({ label, description, items }) => (
        <section key={label} className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold tracking-wide">{label}</h2>
            {description && (
              <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {items.map((s) => <SectionCard key={s.to} section={s} />)}
          </div>
        </section>
      ))}

      <section className="space-y-3 pt-4 border-t">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold tracking-wide">Administration</h2>
          <Badge variant="outline" className="text-xs uppercase">Advanced</Badge>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {ADMIN.map((s) => <SectionCard key={s.to} section={s} muted />)}
        </div>
      </section>
    </div>
  );
}

function SectionCard({ section, muted = false }: { section: Section; muted?: boolean }) {
  const Icon = section.icon;
  return (
    <Link to={section.to} className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
      <Card className={`h-full transition-all border ${muted ? "bg-muted/30" : ""} group-hover:border-primary/40 group-hover:shadow-sm`}>
        <CardContent className="p-4 flex items-start gap-3">
          <div className={`rounded-md p-2 shrink-0 ${muted ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm flex items-center gap-1.5">
              <span className="truncate">{section.title}</span>
              {section.external ? (
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" aria-label="Opens in Employees app" />
              ) : (
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors shrink-0" />
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{section.text}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// Keep the icon import set linted as "used" for tree-shaking clarity
void Settings;
