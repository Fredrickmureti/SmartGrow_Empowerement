import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { subDays, startOfDay, endOfDay } from "date-fns";

export interface ManagerOverrideRecord {
  id: string;
  manager_id: string;
  manager_name: string;
  override_type: string;
  register_id: string | null;
  register_name: string;
  transaction_id: string | null;
  original_value: number | null;
  new_value: number | null;
  override_reason: string | null;
  approved_at: string;
}

export interface SessionAuditRecord {
  id: string;
  cashier_id: string;
  cashier_name: string;
  register_id: string;
  register_name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  locked_at: string | null;
  lock_count: number;
  force_ended: boolean;
}

export interface SecurityViolation {
  id: string;
  type: 'failed_login' | 'unauthorized_access' | 'session_anomaly' | 'override_pattern';
  severity: 'low' | 'medium' | 'high' | 'critical';
  user_id: string | null;
  user_name: string | null;
  description: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface SecurityAuditSummary {
  total_overrides: number;
  overrides_by_type: Record<string, number>;
  overrides_by_manager: Array<{ manager_id: string; manager_name: string; count: number }>;
  failed_pin_attempts: number;
  sessions_force_ended: number;
  active_sessions: number;
  violations_count: number;
  high_risk_violations: number;
}

interface UsePOSSecurityAuditOptions {
  startDate?: Date;
  endDate?: Date;
  registerId?: string;
}

/**
 * POS Security Audit — STRICTLY company-scoped.
 *
 * Previously this hook was marked SCOPE-EXEMPT on the assumption that the
 * operational risk surface was workspace-wide. That was wrong: override &
 * session audit records belong to the Company that owns the books those
 * overrides affect. Leaking sister-company POS audit trails into a workspace
 * admin's screen would itself be a compliance incident. Every query below
 * now filters on `business_id`, and the hook is disabled until a company
 * is selected.
 */
export function usePOSSecurityAudit(options: UsePOSSecurityAuditOptions = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { 
    startDate = subDays(new Date(), 7), 
    endDate = new Date(),
    registerId 
  } = options;

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const scopeReady = !!orgId && !!businessId;

  // Manager Overrides
  const { data: managerOverrides = [], isLoading: isOverridesLoading } = useQuery({
    queryKey: ["pos-security-overrides", orgId, businessId, startDate, endDate, registerId],
    queryFn: async (): Promise<ManagerOverrideRecord[]> => {
      if (!scopeReady) return [];

      let query = supabase
        .from("pos_manager_overrides")
        .select(`
          id,
          manager_id,
          override_type,
          register_id,
          transaction_id,
          original_value,
          new_value,
          override_reason,
          approved_at
        `)
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .gte("approved_at", startOfDay(startDate).toISOString())
        .lte("approved_at", endOfDay(endDate).toISOString())
        .order("approved_at", { ascending: false });

      if (registerId) {
        query = query.eq("register_id", registerId);
      }

      const { data: overrides, error } = await query;
      if (error) throw error;
      if (!overrides?.length) return [];

      // Get manager names
      const managerIds = [...new Set(overrides.map(o => o.manager_id))];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", managerIds);

      const profileMap = new Map<string, string>(
        profiles?.map(p => [p.user_id, p.full_name || p.email || "Unknown"]) || []
      );

      // Get register names
      const registerIds = [...new Set(overrides.map(o => o.register_id).filter(Boolean))] as string[];
      const { data: registers } = registerIds.length > 0 ? await supabase
        .from("pos_registers")
        .select("id, register_name")
        .in("id", registerIds) : { data: [] };

      const registerMap = new Map<string, string>();
      registers?.forEach(r => {
        registerMap.set(r.id, r.register_name);
      });

      return overrides.map(override => ({
        id: override.id,
        manager_id: override.manager_id,
        manager_name: profileMap.get(override.manager_id) || "Unknown",
        override_type: override.override_type,
        register_id: override.register_id,
        register_name: override.register_id ? registerMap.get(override.register_id) || "Unknown" : "N/A",
        transaction_id: override.transaction_id,
        original_value: override.original_value,
        new_value: override.new_value,
        override_reason: override.override_reason,
        approved_at: override.approved_at,
      }));
    },
    enabled: scopeReady,
  });

  // Session Audit
  const { data: sessionAudit = [], isLoading: isSessionsLoading } = useQuery({
    queryKey: ["pos-security-sessions", orgId, businessId, startDate, endDate, registerId],
    queryFn: async (): Promise<SessionAuditRecord[]> => {
      if (!scopeReady) return [];

      let query = supabase
        .from("pos_sessions")
        .select(`
          id,
          cashier_id,
          register_id,
          status,
          started_at,
          ended_at,
          locked_at
        `)
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .gte("started_at", startOfDay(startDate).toISOString())
        .lte("started_at", endOfDay(endDate).toISOString())
        .order("started_at", { ascending: false });

      if (registerId) {
        query = query.eq("register_id", registerId);
      }

      const { data: sessions, error } = await query;
      if (error) throw error;
      if (!sessions?.length) return [];

      // Get cashier names
      const cashierIds = [...new Set(sessions.map(s => s.cashier_id))];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", cashierIds);

      const profileMap = new Map<string, string>(
        profiles?.map(p => [p.user_id, p.full_name || p.email || "Unknown"]) || []
      );

      // Get register names
      const registerIds = [...new Set(sessions.map(s => s.register_id))];
      const { data: registers } = await supabase
        .from("pos_registers")
        .select("id, register_name")
        .in("id", registerIds);

      const registerMap = new Map<string, string>(
        registers?.map(r => [r.id, r.register_name]) || []
      );

      return sessions.map(session => ({
        id: session.id,
        cashier_id: session.cashier_id,
        cashier_name: profileMap.get(session.cashier_id) || "Unknown",
        register_id: session.register_id,
        register_name: registerMap.get(session.register_id) || "Unknown",
        status: session.status,
        started_at: session.started_at,
        ended_at: session.ended_at,
        locked_at: session.locked_at,
        lock_count: 0, // Would need tracking in DB
        force_ended: session.status === "force_ended",
      }));
    },
    enabled: scopeReady,
  });

  // Security Violations Detection
  const { data: securityViolations = [], isLoading: isViolationsLoading } = useQuery({
    queryKey: ["pos-security-violations", orgId, businessId, startDate, endDate],
    queryFn: async (): Promise<SecurityViolation[]> => {
      if (!scopeReady) return [];

      const violations: SecurityViolation[] = [];
      const startISO = startOfDay(startDate).toISOString();
      const endISO = endOfDay(endDate).toISOString();

      // Check for override patterns (multiple overrides by same manager in short time)
      const { data: overrides } = await supabase
        .from("pos_manager_overrides")
        .select("id, manager_id, override_type, approved_at")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .gte("approved_at", startISO)
        .lte("approved_at", endISO);

      if (overrides?.length) {
        // Group by manager and check for suspicious patterns
        const byManager = new Map<string, typeof overrides>();
        overrides.forEach(o => {
          if (!byManager.has(o.manager_id)) {
            byManager.set(o.manager_id, []);
          }
          byManager.get(o.manager_id)!.push(o);
        });

        // Get manager names
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", [...byManager.keys()]);

        const profileMap = new Map<string, string>(
          profiles?.map(p => [p.user_id, p.full_name || p.email]) || []
        );

        byManager.forEach((managerOverrides, managerId) => {
          // Check for excessive overrides (more than 20 in period)
          if (managerOverrides.length > 20) {
            violations.push({
              id: `override_pattern_${managerId}`,
              type: 'override_pattern',
              severity: managerOverrides.length > 50 ? 'high' : 'medium',
              user_id: managerId,
              user_name: profileMap.get(managerId) || null,
              description: `${managerOverrides.length} manager overrides in period`,
              details: { count: managerOverrides.length },
              created_at: new Date().toISOString(),
            });
          }

          // Check for void-heavy override pattern
          const voidOverrides = managerOverrides.filter(o => o.override_type === 'void_transaction');
          if (voidOverrides.length > 10) {
            violations.push({
              id: `void_pattern_${managerId}`,
              type: 'override_pattern',
              severity: 'high',
              user_id: managerId,
              user_name: profileMap.get(managerId) || null,
              description: `${voidOverrides.length} void transaction overrides`,
              details: { void_count: voidOverrides.length },
              created_at: new Date().toISOString(),
            });
          }
        });
      }

      // Check for session anomalies (very short sessions or force-ended)
      const { data: sessions } = await supabase
        .from("pos_sessions")
        .select("id, cashier_id, status, started_at, ended_at")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .gte("started_at", startISO)
        .lte("started_at", endISO);

      if (sessions?.length) {
        const forceEnded = sessions.filter(s => s.status === "force_ended");
        if (forceEnded.length > 5) {
          violations.push({
            id: `session_anomaly_force_ended`,
            type: 'session_anomaly',
            severity: forceEnded.length > 10 ? 'high' : 'medium',
            user_id: null,
            user_name: null,
            description: `${forceEnded.length} sessions were force-ended`,
            details: { force_ended_count: forceEnded.length },
            created_at: new Date().toISOString(),
          });
        }
      }

      return violations.sort((a, b) => {
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });
    },
    enabled: scopeReady,
  });

  // Audit Summary
  const { data: auditSummary, isLoading: isSummaryLoading } = useQuery({
    queryKey: ["pos-security-summary", orgId, businessId, startDate, endDate],
    queryFn: async (): Promise<SecurityAuditSummary> => {
      if (!scopeReady) {
        return {
          total_overrides: 0,
          overrides_by_type: {},
          overrides_by_manager: [],
          failed_pin_attempts: 0,
          sessions_force_ended: 0,
          active_sessions: 0,
          violations_count: 0,
          high_risk_violations: 0,
        };
      }

      const startISO = startOfDay(startDate).toISOString();
      const endISO = endOfDay(endDate).toISOString();

      // Get overrides
      const { data: overrides } = await supabase
        .from("pos_manager_overrides")
        .select("id, manager_id, override_type")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .gte("approved_at", startISO)
        .lte("approved_at", endISO);

      const overridesByType: Record<string, number> = {};
      const overridesByManager = new Map<string, number>();

      overrides?.forEach(o => {
        overridesByType[o.override_type] = (overridesByType[o.override_type] || 0) + 1;
        overridesByManager.set(o.manager_id, (overridesByManager.get(o.manager_id) || 0) + 1);
      });

      // Get manager names
      const managerIds = [...overridesByManager.keys()];
      const { data: profiles } = managerIds.length > 0 ? await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", managerIds) : { data: [] };

      const profileMap = new Map<string, string>();
      profiles?.forEach(p => {
        profileMap.set(p.user_id, p.full_name || p.email || "Unknown");
      });

      // Get session stats
      const { data: sessions } = await supabase
        .from("pos_sessions")
        .select("id, status")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .gte("started_at", startISO)
        .lte("started_at", endISO);

      const forceEnded = sessions?.filter(s => s.status === "force_ended").length || 0;
      
      // Active sessions (company-scoped)
      const { count: activeSessions } = await supabase
        .from("pos_sessions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .eq("status", "active");

      const highRiskViolations = securityViolations.filter(
        v => v.severity === 'critical' || v.severity === 'high'
      ).length;

      return {
        total_overrides: overrides?.length || 0,
        overrides_by_type: overridesByType,
        overrides_by_manager: [...overridesByManager.entries()].map(([id, count]) => ({
          manager_id: id,
          manager_name: profileMap.get(id) || "Unknown",
          count,
        })).sort((a, b) => b.count - a.count),
        failed_pin_attempts: 0, // Would need separate tracking
        sessions_force_ended: forceEnded,
        active_sessions: activeSessions || 0,
        violations_count: securityViolations.length,
        high_risk_violations: highRiskViolations,
      };
    },
    enabled: scopeReady,
  });

  return {
    managerOverrides,
    isOverridesLoading,
    sessionAudit,
    isSessionsLoading,
    securityViolations,
    isViolationsLoading,
    auditSummary,
    isSummaryLoading,
    isLoading: isOverridesLoading || isSessionsLoading || isViolationsLoading || isSummaryLoading,
  };
}
