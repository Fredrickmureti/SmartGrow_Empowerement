import { normalizeError } from "@/services/resilience";
/**
 * Table Bookings Hook
 * 
 * Manages restaurant table reservations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { toast } from "sonner";
import { format } from "date-fns";

export interface TableBooking {
  id: string;
  organization_id: string;
  table_id: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  party_size: number;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: "confirmed" | "checked_in" | "seated" | "completed" | "no_show" | "cancelled";
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined data
  table?: {
    id: string;
    table_number: string;
    seats: number;
    floor_id: string;
  };
}

export interface CreateBookingInput {
  table_id: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  party_size: number;
  booking_date: Date;
  start_time: string; // HH:mm format
  end_time: string;   // HH:mm format
  notes?: string;
}

export interface UpdateBookingInput {
  id: string;
  table_id?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  party_size?: number;
  booking_date?: Date;
  start_time?: string;
  end_time?: string;
  status?: TableBooking["status"];
  notes?: string;
}

export function useTableBookings(date?: Date) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  // Stage B6 branch isolation: bookings carry branch_id; scope all reads and
  // stamp branch_id on insert so the server-side trigger accepts the write.
  const { currentBranch } = useBranch();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;
  const bookingDate = date ? format(date, "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd");

  // Fetch bookings for a specific date
  const bookingsQuery = useQuery({
    queryKey: ["pos-table-bookings", orgId, bizId, branchId, bookingDate],
    queryFn: async () => {
      if (!orgId || !bizId) return [];

      let query = supabase
        .from("pos_table_bookings")
        .select(`
          *,
          table:pos_tables(id, table_number, seats, floor_id)
        `)
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .eq("booking_date", bookingDate)
        .order("start_time", { ascending: true });
      if (branchId) query = query.eq("branch_id", branchId);
      const { data, error } = await query;

      if (error) throw error;
      return data as TableBooking[];
    },
    enabled: !!orgId && !!bizId,
  });

  // Fetch upcoming bookings (next 7 days)
  const upcomingBookingsQuery = useQuery({
    queryKey: ["pos-table-bookings-upcoming", orgId, bizId, branchId],
    queryFn: async () => {
      if (!orgId || !bizId) return [];

      const today = format(new Date(), "yyyy-MM-dd");
      const nextWeek = format(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), "yyyy-MM-dd");

      let query = supabase
        .from("pos_table_bookings")
        .select(`
          *,
          table:pos_tables(id, table_number, seats, floor_id)
        `)
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .gte("booking_date", today)
        .lte("booking_date", nextWeek)
        .in("status", ["confirmed", "checked_in"])
        .order("booking_date", { ascending: true })
        .order("start_time", { ascending: true });
      if (branchId) query = query.eq("branch_id", branchId);
      const { data, error } = await query;

      if (error) throw error;
      return data as TableBooking[];
    },
    enabled: !!orgId && !!bizId,
  });

  // Create booking
  const createBooking = useMutation({
    mutationFn: async (input: CreateBookingInput) => {
      if (!orgId) throw new Error("No organization selected");
      if (!bizId) throw new Error("No company selected");
      if (!branchId) throw new Error("Select a branch before creating a reservation");

      // Check for conflicts
      const bookingDateStr = format(input.booking_date, "yyyy-MM-dd");
      const { data: conflicts } = await supabase
        .from("pos_table_bookings")
        .select("id")
        .eq("organization_id", orgId)
        .eq("business_id", bizId)
        .eq("branch_id", branchId)
        .eq("table_id", input.table_id)
        .eq("booking_date", bookingDateStr)
        .in("status", ["confirmed", "checked_in", "seated"])
        .or(`start_time.lt.${input.end_time},end_time.gt.${input.start_time}`);

      if (conflicts && conflicts.length > 0) {
        throw new Error("This time slot is already booked");
      }

      const { data, error } = await supabase
        .from("pos_table_bookings")
        .insert({
          organization_id: orgId,
          business_id: bizId,
          branch_id: branchId,
          table_id: input.table_id,
          customer_name: input.customer_name,
          customer_phone: input.customer_phone || null,
          customer_email: input.customer_email || null,
          party_size: input.party_size,
          booking_date: bookingDateStr,
          start_time: input.start_time,
          end_time: input.end_time,
          notes: input.notes || null,
          status: "confirmed",
        } as any)
        .select(`
          *,
          table:pos_tables(id, table_number, seats, floor_id)
        `)
        .single();

      if (error) throw error;
      return data as TableBooking;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-bookings"] });
      toast.success("Booking created successfully");
    },
    onError: (error) => {
      toast.error(normalizeError(error).message);
    },
  });

  // Update booking
  const updateBooking = useMutation({
    mutationFn: async (input: UpdateBookingInput) => {
      const { id, booking_date, ...updates } = input;
      
      const updateData: Record<string, unknown> = { ...updates, updated_at: new Date().toISOString() };
      if (booking_date) {
        updateData.booking_date = format(booking_date, "yyyy-MM-dd");
      }
      
      const { data, error } = await supabase
        .from("pos_table_bookings")
        .update(updateData as any)
        .eq("id", id)
        .select(`
          *,
          table:pos_tables(id, table_number, seats, floor_id)
        `)
        .single();
      
      if (error) throw error;
      return data as TableBooking;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-bookings"] });
      toast.success("Booking updated successfully");
    },
    onError: (error) => {
      toast.error("Failed to update booking: " + normalizeError(error).message);
    },
  });

  // Check in guest
  const checkInBooking = useMutation({
    mutationFn: async (bookingId: string) => {
      const { data, error } = await supabase
        .from("pos_table_bookings")
        .update({
          status: "checked_in",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookingId)
        .select()
        .single();
      
      if (error) throw error;
      return data as TableBooking;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-bookings"] });
      toast.success("Guest checked in");
    },
  });

  // Seat guest (marks as seated and opens table session)
  const seatBooking = useMutation({
    mutationFn: async ({ bookingId, shiftId }: { bookingId: string; shiftId?: string }) => {
      if (!orgId) throw new Error("No organization selected");
      if (!bizId) throw new Error("No company selected");

      // Get booking details
      const { data: booking, error: fetchError } = await supabase
        .from("pos_table_bookings")
        .select("table_id, party_size, notes")
        .eq("id", bookingId)
        .single();

      if (fetchError) throw fetchError;

      // Update booking status
      const { error: updateError } = await supabase
        .from("pos_table_bookings")
        .update({
          status: "seated",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookingId);

      if (updateError) throw updateError;

      // Create table session
      const { data: session, error: sessionError } = await supabase
        .from("pos_table_sessions")
        .insert({
          organization_id: orgId,
          business_id: bizId,
          table_id: booking.table_id,
          shift_id: shiftId || null,
          status: "occupied",
          guests_count: booking.party_size,
          notes: `Reservation: ${booking.notes || ""}`,
          opened_at: new Date().toISOString(),
        } as any)
        .select()
        .single();

      if (sessionError) throw sessionError;

      return session;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-bookings"] });
      queryClient.invalidateQueries({ queryKey: ["pos-table-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["pos-tables"] });
      toast.success("Guest seated");
    },
    onError: (error) => {
      toast.error("Failed to seat guest: " + normalizeError(error).message);
    },
  });

  // Mark as no-show
  const markNoShow = useMutation({
    mutationFn: async (bookingId: string) => {
      const { data, error } = await supabase
        .from("pos_table_bookings")
        .update({
          status: "no_show",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookingId)
        .select()
        .single();
      
      if (error) throw error;
      return data as TableBooking;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-bookings"] });
      toast.success("Marked as no-show");
    },
  });

  // Cancel booking
  const cancelBooking = useMutation({
    mutationFn: async (bookingId: string) => {
      const { data, error } = await supabase
        .from("pos_table_bookings")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookingId)
        .select()
        .single();
      
      if (error) throw error;
      return data as TableBooking;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-table-bookings"] });
      toast.success("Booking cancelled");
    },
  });

  // Get bookings for a specific table
  const getTableBookings = (tableId: string) => {
    return (bookingsQuery.data || []).filter(b => b.table_id === tableId);
  };

  return {
    bookings: bookingsQuery.data || [],
    upcomingBookings: upcomingBookingsQuery.data || [],
    isLoading: bookingsQuery.isLoading,
    createBooking,
    updateBooking,
    checkInBooking,
    seatBooking,
    markNoShow,
    cancelBooking,
    getTableBookings,
  };
}
