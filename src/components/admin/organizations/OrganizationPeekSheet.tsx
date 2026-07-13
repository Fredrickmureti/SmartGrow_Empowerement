/**
 * OrganizationPeekSheet — read-mostly peek for the Organizations list.
 * Opened via `?peek=<orgId>` on `/admin-management/organizations`.
 * Follows the peek convention in `docs/design-system/audit/platform-admin.md`.
 *
 * The peek reuses the already-loaded row data (no new query on open) and
 * exposes two quick actions:
 *   - Open full workspace → `/admin-management/organizations/:id`
 *   - Manage subscription → `/admin-management/organizations/:id/subscription`
 */
import { useNavigate } from "react-router-dom";
import { format, differenceInDays } from "date-fns";
import {
  Building2,
  Users,
  FileText,
  Calendar,
  Mail,
  Globe,
  CreditCard,
  AlertTriangle,
  Clock,
  CheckCircle,
  XCircle,
  CalendarClock,
  PauseCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DocumentPeekShell } from "@/design-system";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";

export interface OrganizationPeekRow {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  ownerEmail: string | null;
  resolvedEmail: string | null;
  base_currency: string | null;
  created_at: string;
  memberCount: number;
  invoiceCount: number;
  totalRevenue: number;
  subscription_plan_id?: string | null;
  subscription_status?: string | null;
  subscription_ends_at?: string | null;
  trial_ends_at?: string | null;
  is_suspended?: boolean;
  suspended_reason?: string | null;
  scheduled_deletion_at?: string | null;
}

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; icon: React.ComponentType<{ className?: string }> }
> = {
  trial: { label: "Trial", color: "bg-blue-500/10 text-blue-600 border-blue-200", icon: Clock },
  active: {
    label: "Active",
    color: "bg-green-500/10 text-green-600 border-green-200",
    icon: CheckCircle,
  },
  expired: {
    label: "Expired",
    color: "bg-orange-500/10 text-orange-600 border-orange-200",
    icon: XCircle,
  },
  cancelled: {
    label: "Cancelled",
    color: "bg-gray-500/10 text-gray-600 border-gray-200",
    icon: XCircle,
  },
  past_due: {
    label: "Past Due",
    color: "bg-yellow-500/10 text-yellow-600 border-yellow-200",
    icon: AlertTriangle,
  },
  suspended: {
    label: "Suspended",
    color: "bg-red-500/10 text-red-600 border-red-200",
    icon: AlertTriangle,
  },
  none: {
    label: "No subscription",
    color: "bg-muted text-muted-foreground border-border",
    icon: XCircle,
  },
};

function resolveStatus(org: OrganizationPeekRow) {
  if (org.is_suspended) return "suspended";
  return org.subscription_status || "none";
}

function daysRemaining(org: OrganizationPeekRow): number | null {
  const target = org.subscription_ends_at || org.trial_ends_at;
  if (!target) return null;
  return differenceInDays(new Date(target), new Date());
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organization: OrganizationPeekRow | null;
}

export function OrganizationPeekSheet({ open, onOpenChange, organization }: Props) {
  const navigate = useNavigate();
  const { formatCurrency } = useAdminCurrency();

  const org = organization;
  const status = org ? resolveStatus(org) : "none";
  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.none;
  const StatusIcon = statusConfig.icon;
  const days = org ? daysRemaining(org) : null;

  const fullPageHref = org
    ? `/admin-management/organizations/${org.id}`
    : undefined;

  const title = org ? (
    <div className="flex items-center gap-3 min-w-0">
      <div className="h-10 w-10 shrink-0 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center">
        <Building2 className="h-5 w-5 text-primary" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <span className="truncate">{org.name}</span>
          <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
            {org.slug}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5 truncate">
          <Mail className="h-3 w-3 shrink-0" />
          <span className="truncate">{org.resolvedEmail || "No contact email"}</span>
        </p>
      </div>
    </div>
  ) : (
    "Organization"
  );

  return (
    <DocumentPeekShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      fullPageHref={fullPageHref}
      extraHeaderActions={
        org && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              navigate(`/admin-management/organizations/${org.id}/subscription`);
            }}
          >
            <CreditCard className="mr-1.5 h-4 w-4" />
            Subscription
          </Button>
        )
      }
    >
      {org && (
        <div className="space-y-4 p-1">
          {/* Status */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`${statusConfig.color} border text-xs`}>
              <StatusIcon className="h-3 w-3 mr-1" />
              {statusConfig.label}
            </Badge>
            {days !== null && (
              <span
                className={`text-xs ${
                  days <= 0
                    ? "text-destructive"
                    : days <= 7
                    ? "text-yellow-600"
                    : "text-muted-foreground"
                }`}
              >
                {days <= 0
                  ? `Expired ${Math.abs(days)} days ago`
                  : `${days} days remaining`}
              </span>
            )}
            {org.scheduled_deletion_at && (
              <Badge
                variant="outline"
                className="border-destructive/50 text-destructive text-[10px] gap-1"
              >
                <CalendarClock className="h-2.5 w-2.5" />
                Purges {format(new Date(org.scheduled_deletion_at), "MMM d")}
              </Badge>
            )}
          </div>

          {org.is_suspended && org.suspended_reason && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive flex items-start gap-2">
              <PauseCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Suspended</p>
                <p className="text-destructive/80 mt-0.5">{org.suspended_reason}</p>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2">
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3">
              <Users className="h-4 w-4 text-blue-500" />
              <div>
                <p className="text-xl font-bold leading-none">{org.memberCount}</p>
                <p className="text-[10px] text-muted-foreground">Members</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3">
              <FileText className="h-4 w-4 text-amber-500" />
              <div>
                <p className="text-xl font-bold leading-none">{org.invoiceCount}</p>
                <p className="text-[10px] text-muted-foreground">Invoices</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3">
              <CreditCard className="h-4 w-4 text-green-600" />
              <div>
                <p className="text-sm font-semibold leading-none truncate">
                  {formatCurrency(org.totalRevenue)}
                </p>
                <p className="text-[10px] text-muted-foreground">Revenue</p>
              </div>
            </div>
          </div>

          <Separator />

          {/* Details */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Details</h3>
            <dl className="grid grid-cols-1 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Mail className="h-3 w-3" />
                  Owner
                </dt>
                <dd className="mt-0.5 truncate">{org.ownerEmail || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Globe className="h-3 w-3" />
                  Currency
                </dt>
                <dd className="mt-0.5 font-mono text-xs">
                  {org.base_currency || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Calendar className="h-3 w-3" />
                  Created
                </dt>
                <dd className="mt-0.5">
                  {format(new Date(org.created_at), "MMM d, yyyy")}
                </dd>
              </div>
              {org.trial_ends_at && (
                <div>
                  <dt className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Clock className="h-3 w-3" />
                    Trial ends
                  </dt>
                  <dd className="mt-0.5">
                    {format(new Date(org.trial_ends_at), "MMM d, yyyy")}
                  </dd>
                </div>
              )}
              {org.subscription_ends_at && (
                <div>
                  <dt className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <CalendarClock className="h-3 w-3" />
                    Subscription ends
                  </dt>
                  <dd className="mt-0.5">
                    {format(new Date(org.subscription_ends_at), "MMM d, yyyy")}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}
    </DocumentPeekShell>
  );
}
