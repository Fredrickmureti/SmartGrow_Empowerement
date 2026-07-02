import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { looksLikeUUID } from "@/lib/looksLikeUUID";
import { normalizeError } from "@/services/resilience";

/** Lifecycle + logistics RPC wrappers for delivery notes. */

export interface DispatchPayload {
  shipping_method?: string;
  carrier_id?: string | null;
  tracking_number?: string;
  dispatch_officer_id?: string | null;
  dispatch_route?: string;
  dispatch_instructions?: string;
  driver_name?: string;
  vehicle_number?: string;
  freight_cost?: number | null;
  freight_currency?: string;
}

export interface PodPayload {
  signature_url?: string;
  photo_urls?: string[];
  received_by_contact_id?: string | null;
  received_by_name?: string;
  received_at?: string;
  gps_lat?: number;
  gps_lng?: number;
  notes?: string;
}

function useInvalidateDn(deliveryNoteId: string | null | undefined) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["delivery-notes"] });
    qc.invalidateQueries({ queryKey: ["delivery-notes-paginated"] });
    qc.invalidateQueries({ queryKey: ["delivery-note-events", deliveryNoteId] });
    qc.invalidateQueries({ queryKey: ["delivery-proofs", deliveryNoteId] });
    qc.invalidateQueries({ queryKey: ["invoice-delivery-status"] });
    qc.invalidateQueries({ queryKey: ["warehouse-stock"] });
    qc.invalidateQueries({ queryKey: ["products"] });
  };
}

async function uid() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Not authenticated");
  return data.user.id;
}

export function useMarkDeliveryReady(deliveryNoteId: string | null) {
  const invalidate = useInvalidateDn(deliveryNoteId);
  return useMutation({
    mutationFn: async (id: string) => {
      const user_id = await uid();
      const { data, error } = await supabase.rpc("mark_delivery_ready_atomic" as any, {
        p_dn_id: id,
        p_user_id: user_id,
      });
      if (error) throw error;
      if (!(data as any)?.success) throw new Error((data as any)?.error || "Failed");
      return data;
    },
    onSuccess: () => { toast.success("Marked ready to dispatch"); invalidate(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed"),
  });
}

export function useDispatchDelivery(deliveryNoteId: string | null) {
  const invalidate = useInvalidateDn(deliveryNoteId);
  return useMutation({
    mutationFn: async (args: { id: string; payload: DispatchPayload }) => {
      const user_id = await uid();
      const { data, error } = await supabase.rpc("dispatch_delivery_atomic" as any, {
        p_dn_id: args.id,
        p_user_id: user_id,
        p_payload: args.payload as any,
      });
      if (error) throw error;
      if (!(data as any)?.success) throw new Error((data as any)?.error || "Failed");
      return data;
    },
    onSuccess: () => { toast.success("Dispatched"); invalidate(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Dispatch failed"),
  });
}

export function useUpdateDeliveryLogistics(deliveryNoteId: string | null) {
  const invalidate = useInvalidateDn(deliveryNoteId);
  return useMutation({
    mutationFn: async (args: { id: string; payload: Record<string, any> }) => {
      const user_id = await uid();
      const { data, error } = await supabase.rpc("update_delivery_logistics_atomic" as any, {
        p_dn_id: args.id,
        p_user_id: user_id,
        p_payload: args.payload as any,
      });
      if (error) throw error;
      if (!(data as any)?.success) throw new Error((data as any)?.error || "Failed");
      return data;
    },
    onSuccess: () => { toast.success("Logistics updated"); invalidate(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Update failed"),
  });
}

export function useCompleteDelivery(deliveryNoteId: string | null) {
  const invalidate = useInvalidateDn(deliveryNoteId);
  return useMutation({
    mutationFn: async (args: { id: string; received_by?: string; pod?: PodPayload | null }) => {
      const user_id = await uid();
      if (args.received_by && looksLikeUUID(args.received_by)) {
        throw new Error("Recipient must be a name, not an identifier.");
      }
      const { data, error } = await supabase.rpc("complete_delivery_atomic" as any, {
        p_dn_id: args.id,
        p_user_id: user_id,
        p_received_by: args.received_by ?? null,
        p_pod: (args.pod ?? null) as any,
        p_received_by_user_id: user_id,
      });
      if (error) throw error;
      if (!(data as any)?.success) throw new Error((data as any)?.error || "Failed");
      return data as any;
    },
    onSuccess: (data) => {
      toast.success(
        `Delivered — ${data.movements_created} stock movement(s)${data.gl_posted ? ", COGS posted" : ""}`,
      );
      invalidate();
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Complete failed"),
  });
}

export function useRecordPartialDelivery(deliveryNoteId: string | null) {
  const invalidate = useInvalidateDn(deliveryNoteId);
  return useMutation({
    mutationFn: async (args: {
      id: string;
      line_qtys: Array<{ item_id: string; quantity_delivered: number }>;
      create_backorder: boolean;
      received_by?: string;
      pod?: PodPayload | null;
    }) => {
      const user_id = await uid();
      if (args.received_by && looksLikeUUID(args.received_by)) {
        throw new Error("Recipient must be a name, not an identifier.");
      }
      const { data, error } = await supabase.rpc("record_partial_delivery_atomic" as any, {
        p_dn_id: args.id,
        p_user_id: user_id,
        p_line_qtys: args.line_qtys as any,
        p_create_backorder: args.create_backorder,
        p_received_by: args.received_by ?? null,
        p_pod: (args.pod ?? null) as any,
        p_received_by_user_id: user_id,
      });
      if (error) throw error;
      if (!(data as any)?.success) throw new Error((data as any)?.error || "Failed");
      return data as any;
    },
    onSuccess: (data) => {
      toast.success(data?.backorder_id ? "Partial delivery recorded; backorder created" : "Partial delivery recorded");
      invalidate();
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed"),
  });
}

export interface DeliveryNoteEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  actor_id: string | null;
  notes: string | null;
  payload: any;
}

export function useDeliveryNoteEvents(deliveryNoteId: string | null) {
  return useQuery<DeliveryNoteEvent[]>({
    queryKey: ["delivery-note-events", deliveryNoteId],
    enabled: !!deliveryNoteId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("delivery_note_events" as any)
        .select("id, event_type, occurred_at, actor_id, notes, payload")
        .eq("delivery_note_id", deliveryNoteId!)
        .order("occurred_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any;
    },
  });
}

export interface DeliveryProof {
  id: string;
  signature_url: string | null;
  photo_urls: string[] | null;
  received_by_name: string | null;
  received_at: string;
  notes: string | null;
}

export function useDeliveryProofs(deliveryNoteId: string | null) {
  return useQuery<DeliveryProof[]>({
    queryKey: ["delivery-proofs", deliveryNoteId],
    enabled: !!deliveryNoteId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("delivery_proofs" as any)
        .select("id, signature_url, photo_urls, received_by_name, received_at, notes")
        .eq("delivery_note_id", deliveryNoteId!)
        .order("received_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any;
    },
  });
}

export interface Carrier {
  id: string;
  name: string;
  contact_phone: string | null;
  tracking_url_template: string | null;
  is_active: boolean;
}

export function useCarriers(opts: { includeInactive?: boolean } = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const query = useQuery<Carrier[]>({
    queryKey: ["carriers", currentOrg?.id, currentBusiness?.id, opts.includeInactive ?? false],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("carriers" as any)
        .select("id, name, contact_phone, tracking_url_template, is_active")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .order("name");
      if (!opts.includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as any;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["carriers"] });

  const createCarrier = useMutation({
    mutationFn: async (input: { name: string; contact_phone?: string; tracking_url_template?: string }) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("Missing org/business");
      const user_id = await uid();
      const { data, error } = await supabase
        .from("carriers" as any)
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          name: input.name,
          contact_phone: input.contact_phone ?? null,
          tracking_url_template: input.tracking_url_template ?? null,
          created_by: user_id,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => { toast.success("Carrier created"); invalidate(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed to create carrier"),
  });

  const updateCarrier = useMutation({
    mutationFn: async (input: { id: string; patch: Partial<Pick<Carrier, "name" | "contact_phone" | "tracking_url_template" | "is_active">> }) => {
      const { error } = await supabase
        .from("carriers" as any)
        .update(input.patch as any)
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Carrier updated"); invalidate(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Update failed"),
  });

  return { ...query, carriers: query.data ?? [], createCarrier, updateCarrier };
}