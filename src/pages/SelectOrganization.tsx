import { useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import { Building2, Shield, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS } from "@/lib/permissions";

// SCOPE-TRIGGER-EXEMPT: post-login org/workspace picker, not the in-app scope switcher
function isSafeReturnTo(path: string | null | undefined): path is string {
  return typeof path === "string"
    && path.startsWith("/")
    && !path.startsWith("//")
    && !path.startsWith("/select-organization");
}

/**
 * SelectOrganization — explicit workspace picker.
 *
 * After the architecture audit (Steps 1–5 in .lovable/plan.md) this page
 * is ONLY reached intentionally:
 *   - the user clicked "Switch workspace" in the topbar, or
 *   - `flowRouter` decided post-sign-in that the user has >1 orgs and no
 *     `last_org_id` or `intendedPath`.
 *
 * No guard `<Navigate>`s here anymore. That means the page no longer
 * needs the legacy 250 ms `settled` timer or the sibling-tab interval
 * leader probe — both existed solely to *recover* from being landed on
 * by accident. Single-org and zero-org users never reach this URL.
 */
export default function SelectOrganization() {
  const { sessionData, isLoading, switchOrganization } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const orgs = sessionData?.organizations || [];

  const returnTo = useMemo(() => {
    const raw = searchParams.get("returnTo");
    return isSafeReturnTo(raw) ? raw : "/home";
  }, [searchParams]);

  // If the user lands here intentionally with 0 or 1 org (e.g. someone
  // deep-linked the route), honour the intent immediately. No timers, no
  // sibling-tab probes — the upstream invariants (selector + server-trusted
  // last_org_id) guarantee this is a real terminal state, not a hydration
  // race.
  useEffect(() => {
    if (isLoading) return;
    if (orgs.length === 0) {
      navigate("/onboarding-setup", { replace: true });
    } else if (orgs.length === 1) {
      switchOrganization(orgs[0].id);
      navigate(returnTo, { replace: true });
    }
  }, [isLoading, orgs, navigate, switchOrganization, returnTo]);

  const handleSelect = (org: typeof orgs[0]) => {
    switchOrganization(org.id);
    navigate(returnTo, { replace: true });
  };

  if (isLoading || orgs.length <= 1) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg animate-fade-in">
        <div className="text-center mb-8">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <Building2 className="h-7 w-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Select Organization</h1>
          <p className="text-muted-foreground mt-1">Choose which organization to work in</p>
        </div>

        <div className="space-y-3">
          {orgs.map((org) => (
            <button
              key={org.id}
              onClick={() => handleSelect(org)}
              className="w-full flex items-center gap-4 p-4 rounded-xl border bg-card hover:bg-accent/50 transition-colors text-left group"
            >
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-lg font-bold text-primary">
                  {org.name.charAt(0).toUpperCase()}
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <p className="font-semibold text-foreground truncate">{org.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className="text-xs">
                    <Shield className="h-3 w-3 mr-1" />
                    {ROLE_LABELS[org.role] || org.role}
                  </Badge>
                  <Badge variant={org.user_type === "portal" ? "secondary" : "default"} className="text-xs">
                    {org.user_type === "portal" ? "Portal" : "Internal"}
                  </Badge>
                </div>
              </div>

              <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
