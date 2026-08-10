/**
 * Hook for vendor portal functionality
 */
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface VendorPortalData {
  contactId: string | null;
  contactName: string | null;
  organizationId: string | null;
  organizationName: string | null;
}

export interface VendorPO {
  id: string;
  po_number: string;
  status: string;
  order_date: string;
  expected_date: string | null;
  total: number;
  currency: string;
  notes: string | null;
}

export interface VendorRFQ {
  id: string;
  rfq_id: string;
  rfq_number: string;
  status: string;
  deadline: string | null;
  vendor_status: string;
  quoted_total: number | null;
}

export function useVendorPortal() {
  const { user } = useAuth();
  const [isVendor, setIsVendor] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [portalData, setPortalData] = useState<VendorPortalData>({
    contactId: null,
    contactName: null,
    organizationId: null,
    organizationName: null,
  });
  const [purchaseOrders, setPurchaseOrders] = useState<VendorPO[]>([]);
  const [rfqs, setRfqs] = useState<VendorRFQ[]>([]);

  useEffect(() => {
    if (user) {
      checkVendorStatus();
    } else {
      setIsLoading(false);
    }
  }, [user?.id]);

  const checkVendorStatus = async () => {
    if (!user) return;
    setIsLoading(true);

    try {
      // Check if user is a vendor portal user via metadata
      const isPortalUser = user.user_metadata?.is_vendor_portal === true;
      
      if (!isPortalUser) {
        // Also check contacts table directly
        const { data: contact } = await supabase
          .from("contacts")
          .select("id, name, organization_id")
          .eq("portal_user_id", user.id)
          .single();

        if (!contact) {
          setIsVendor(false);
          setIsLoading(false);
          return;
        }

        // Get org name
        const { data: org } = await supabase
          .from("organizations")
          .select("name")
          .eq("id", contact.organization_id)
          .single();

        setIsVendor(true);
        setPortalData({
          contactId: contact.id,
          contactName: contact.name,
          organizationId: contact.organization_id,
          organizationName: org?.name || null,
        });
      } else {
        const contactId = user.user_metadata.vendor_contact_id;
        const orgId = user.user_metadata.vendor_organization_id;

        const { data: contact } = await supabase
          .from("contacts")
          .select("id, name")
          .eq("id", contactId)
          .single();

        const { data: org } = await supabase
          .from("organizations")
          .select("name")
          .eq("id", orgId)
          .single();

        setIsVendor(true);
        setPortalData({
          contactId: contactId,
          contactName: contact?.name || null,
          organizationId: orgId,
          organizationName: org?.name || null,
        });
      }
    } catch (err) {
      console.error("Error checking vendor status:", err);
      setIsVendor(false);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchPurchaseOrders = async () => {
    if (!portalData.contactId) return;

    const { data, error } = await supabase
      .from("purchase_orders")
      .select("id, po_number, status, order_date, expected_date, total, currency, notes")
      .eq("vendor_id", portalData.contactId)
      .order("order_date", { ascending: false });

    if (!error && data) {
      setPurchaseOrders(data as VendorPO[]);
    }
  };

  /**
   * A supplier sees invitations, not RFQ rows: the invitation is the
   * addressed, version-pinned artefact. `id` stays the invitation id so
   * the detail route and `rfq_record_quotation` share one key.
   */
  const fetchRFQs = async () => {
    if (!portalData.contactId) return;

    const { data, error } = await (supabase as any)
      .from("rfq_invitations")
      .select(`
        id,
        rfq_id,
        invitation_state,
        response_deadline,
        rfq_version,
        rfq:rfqs(rfq_number, status, deadline, currency),
        quotations:rfq_quotations(total, quotation_version, state)
      `)
      .eq("supplier_id", portalData.contactId)
      .neq("invitation_state", "superseded")
      .order("created_at", { ascending: false });

    if (!error && data) {
      setRfqs(
        data.map((inv: any) => {
          const live = (inv.quotations ?? [])
            .filter((q: any) => q.state !== "withdrawn" && q.state !== "superseded")
            .sort((a: any, b: any) => b.quotation_version - a.quotation_version)[0];
          return {
            id: inv.id,
            rfq_id: inv.rfq_id,
            rfq_number: inv.rfq?.rfq_number || "",
            status: inv.rfq?.status || "",
            deadline: inv.response_deadline || inv.rfq?.deadline || null,
            vendor_status: inv.invitation_state,
            quoted_total: live?.total ?? null,
          };
        }),
      );
    }
  };


  useEffect(() => {
    if (isVendor && portalData.contactId) {
      fetchPurchaseOrders();
      fetchRFQs();
    }
  }, [isVendor, portalData.contactId]);

  return {
    isVendor,
    isLoading,
    portalData,
    purchaseOrders,
    rfqs,
    refreshPOs: fetchPurchaseOrders,
    refreshRFQs: fetchRFQs,
  };
}

/**
 * Hook for inviting vendors to the portal (used in contacts page)
 */
export function useVendorPortalInvite() {
  const [isInviting, setIsInviting] = useState(false);

  const inviteVendor = async (contactId: string, email: string, organizationId: string) => {
    setIsInviting(true);
    try {
      const { data, error } = await supabase.functions.invoke("vendor-portal-invite", {
        body: { contact_id: contactId, email, organization_id: organizationId },
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      setIsInviting(false);
    }
  };

  return { inviteVendor, isInviting };
}
