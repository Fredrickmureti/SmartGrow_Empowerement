/**
 * Collector assignment hook for the Collections workspace.
 *
 * Loads active assignments + available org members, and exposes
 * assign/unassign mutations that refresh the assignment map in place.
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchCollectorAssignments,
  fetchOrgMembers,
  assignCollector,
  unassignCollector,
  type CollectorAssignment,
  type OrgMember,
} from "@/services/finance/collectorAssignments";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";

export interface AssignmentByContact {
  [contactId: string]: CollectorAssignment;
}

export function useCollectorAssignments() {
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [assignments, setAssignments] = useState<AssignmentByContact>({});
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const orgId = currentBusiness?.organization_id;
  const businessId = currentBusiness?.id ?? null;
  const currentUserId = user?.id ?? null;

  const reload = useCallback(async () => {
    if (!orgId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const [assignMap, memberList] = await Promise.all([
        fetchCollectorAssignments(orgId, businessId),
        fetchOrgMembers(orgId),
      ]);
      const obj: AssignmentByContact = {};
      for (const [contactId, a] of assignMap) {
        obj[contactId] = a;
      }
      setAssignments(obj);
      setMembers(memberList);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Failed to load collector assignments");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, businessId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const assign = useCallback(
    async (contactId: string, collectorUserId: string) => {
      await assignCollector(contactId, collectorUserId, businessId);
      await reload();
    },
    [businessId, reload],
  );

  const unassign = useCallback(
    async (contactId: string) => {
      await unassignCollector(contactId);
      await reload();
    },
    [reload],
  );

  return {
    assignments,
    members,
    currentUserId,
    isLoading,
    error,
    assign,
    unassign,
    reload,
  };
}
