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

  const fetchRFQs = async () => {
    if (!portalData.contactId) return;

    const { data, error } = await supabase
      .from("rfq_vendors")
      .select(`
        id,
        rfq_id,
        status,
        quoted_total,
        rfq:rfqs(rfq_number, status, deadline)
      `)
      .eq("vendor_id", portalData.contactId)
      .order("id", { ascending: false });

    if (!error && data) {
      setRfqs(
        data.map((rv: any) => ({
          id: rv.id,
          rfq_id: rv.rfq_id,
          rfq_number: rv.rfq?.rfq_number || "",
          status: rv.rfq?.status || "",
          deadline: rv.rfq?.deadline || null,
          vendor_status: rv.status,
          quoted_total: rv.quoted_total,
        }))
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
