import { normalizeError } from "@/services/resilience";
/**
 * Waitlist Management Hook
 * 
 * Manages walk-in queue with party sizes and wait time estimates.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useEffect } from "react";
import { toast } from "sonner";

export type WaitlistStatus = "waiting" | "notified" | "seated" | "no_show" | "cancelled";

export interface WaitlistEntry {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  customer_name: string;
  phone: string | null;
  party_size: number;
  notes: string | null;
  quoted_wait_minutes: number | null;
  seating_preference: string | null;
  status: WaitlistStatus;
  check_in_time: string;
  notified_at: string | null;
  seated_at: string | null;
  table_id: string | null;
  created_at: string;
  created_by: string | null;
}

export interface AddToWaitlistInput {
  customer_name: string;
  phone?: string;
  party_size: number;
  notes?: string;
  seating_preference?: string;
  branch_id?: string;
}

export function useWaitlist(branchId?: string) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;

  // Fetch active waitlist
  const waitlistQuery = useQuery({
    queryKey: ["pos-waitlist", orgId, bizId, branchId],
    queryFn: async () => {
      if (!orgId || !bizId) return [];

      let query = supabase
        .from("pos_waitlist")
        .select("*")
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .in("status", ["waiting", "notified"])
        .order("check_in_time", { ascending: true });

      if (branchId) {
        query = query.eq("branch_id", branchId);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data as WaitlistEntry[];
    },
    enabled: !!orgId && !!bizId,
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  // Real-time subscription
  useEffect(() => {
    if (!orgId) return;
    // Stage B: branch-scope realtime to avoid cross-branch waitlist leakage.
    const channelKey = `waitlist-realtime-${orgId}-${bizId ?? 'no-biz'}-${branchId ?? 'no-branch'}`;

    const channel = supabase
      .channel(channelKey)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "pos_waitlist",
          filter: `organization_id=eq.${orgId}`,
        },
        (payload) => {
          const newRow = payload.new as { business_id?: string | null; branch_id?: string | null } | null;
          const oldRow = payload.old as { business_id?: string | null; branch_id?: string | null } | null;
          const payloadBiz = newRow?.business_id ?? oldRow?.business_id ?? null;
          const payloadBranch = newRow?.branch_id ?? oldRow?.branch_id ?? null;
          if (bizId && payloadBiz && payloadBiz !== bizId) return;
          if (branchId && payloadBranch && payloadBranch !== branchId) return;
          queryClient.invalidateQueries({ queryKey: ["pos-waitlist", orgId] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // Stage R11 — include bizId + branchId so resubscribe fires on context switch.
  }, [orgId, bizId, branchId, queryClient]);

  // Add to waitlist
  const addToWaitlist = useMutation({
    mutationFn: async (input: AddToWaitlistInput) => {
      if (!orgId) throw new Error("No organization selected");
      if (!bizId) throw new Error("No company selected");

      const { data: user } = await supabase.auth.getUser();

      // Estimate wait time based on current queue
      const estimatedWait = await estimateWaitTime(input.party_size);

      const { data, error } = await supabase
        .from("pos_waitlist")
        .insert({
          organization_id: orgId,
          business_id: bizId,
          branch_id: input.branch_id || null,
          customer_name: input.customer_name,
          phone: input.phone || null,
          party_size: input.party_size,
          notes: input.notes || null,
          seating_preference: input.seating_preference || null,
          quoted_wait_minutes: estimatedWait,
          status: "waiting",
          created_by: user.user?.id,
        } as any)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-waitlist", orgId] });
      toast.success("Added to waitlist");
    },
    onError: (error) => {
      toast.error("Failed to add to waitlist: " + normalizeError(error).message);
    },
  });

  // Notify customer (table ready)
  const notifyCustomer = useMutation({
    mutationFn: async (entryId: string) => {
      const { data, error } = await supabase
        .from("pos_waitlist")
        .update({
          status: "notified",
          notified_at: new Date().toISOString(),
        })
        .eq("id", entryId)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-waitlist", orgId] });
      toast.success("Customer notified");
    },
    onError: (error) => {
      toast.error("Failed to notify customer: " + normalizeError(error).message);
    },
  });

  // Seat customer
  const seatCustomer = useMutation({
    mutationFn: async ({ entryId, tableId }: { entryId: string; tableId?: string }) => {
      const { data, error } = await supabase
        .from("pos_waitlist")
        .update({
          status: "seated",
          seated_at: new Date().toISOString(),
          table_id: tableId || null,
        })
        .eq("id", entryId)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-waitlist", orgId] });
      toast.success("Customer seated");
    },
    onError: (error) => {
      toast.error("Failed to seat customer: " + normalizeError(error).message);
    },
  });

  // Mark as no-show
  const markNoShow = useMutation({
    mutationFn: async (entryId: string) => {
      const { data, error } = await supabase
        .from("pos_waitlist")
        .update({ status: "no_show" })
        .eq("id", entryId)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-waitlist", orgId] });
      toast.success("Marked as no-show");
    },
    onError: (error) => {
      toast.error("Failed to update status: " + normalizeError(error).message);
    },
  });

  // Cancel entry
  const cancelEntry = useMutation({
    mutationFn: async (entryId: string) => {
      const { data, error } = await supabase
        .from("pos_waitlist")
        .update({ status: "cancelled" })
        .eq("id", entryId)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-waitlist", orgId] });
      toast.success("Entry cancelled");
    },
    onError: (error) => {
      toast.error("Failed to cancel entry: " + normalizeError(error).message);
    },
  });

  // Update entry
  const updateEntry = useMutation({
    mutationFn: async ({ id, ...updates }: Partial<WaitlistEntry> & { id: string }) => {
      const { data, error } = await supabase
        .from("pos_waitlist")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-waitlist", orgId] });
      toast.success("Entry updated");
    },
    onError: (error) => {
      toast.error("Failed to update entry: " + normalizeError(error).message);
    },
  });

  // Estimate wait time (simple algorithm based on queue position and average turnover)
  const estimateWaitTime = async (partySize: number): Promise<number> => {
    const waitlist = waitlistQuery.data || [];
    const position = waitlist.length;
    
    // Average 20 minutes per party, adjusted by size
    const baseTime = 20;
    const sizeMultiplier = partySize > 4 ? 1.5 : 1;
    
    return Math.round(position * baseTime * sizeMultiplier);
  };

  // Get position in queue
  const getQueuePosition = (entryId: string): number => {
    const waitlist = waitlistQuery.data || [];
    const index = waitlist.findIndex(e => e.id === entryId);
    return index >= 0 ? index + 1 : 0;
  };

  // Calculate actual wait time
  const getActualWaitTime = (entry: WaitlistEntry): number => {
    const checkIn = new Date(entry.check_in_time);
    const now = entry.seated_at ? new Date(entry.seated_at) : new Date();
    return Math.round((now.getTime() - checkIn.getTime()) / 60000);
  };

  // Get waitlist stats
  const getStats = () => {
    const waitlist = waitlistQuery.data || [];
    const waiting = waitlist.filter(e => e.status === "waiting");
    const notified = waitlist.filter(e => e.status === "notified");
    
    const totalParties = waiting.length + notified.length;
    const totalGuests = waitlist.reduce((sum, e) => sum + e.party_size, 0);
    
    // Average wait time for currently waiting
    const avgWait = waiting.length > 0
      ? Math.round(waiting.reduce((sum, e) => sum + getActualWaitTime(e), 0) / waiting.length)
      : 0;
    
    return {
      totalParties,
      totalGuests,
      waitingCount: waiting.length,
      notifiedCount: notified.length,
      averageWaitMinutes: avgWait,
    };
  };

  return {
    waitlist: waitlistQuery.data || [],
    isLoading: waitlistQuery.isLoading,
    addToWaitlist,
    notifyCustomer,
    seatCustomer,
    markNoShow,
    cancelEntry,
    updateEntry,
    getQueuePosition,
    getActualWaitTime,
    getStats,
  };
}
