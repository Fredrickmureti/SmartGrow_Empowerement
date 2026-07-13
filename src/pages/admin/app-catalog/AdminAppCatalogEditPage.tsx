// @ts-nocheck - Admin tables not in auto-generated types
/**
 * AdminAppCatalogEditPage — loads a platform_apps row and renders the
 * edit workspace (`AdminAppCatalogForm`).
 * Route: `/admin-management/app-catalog/:id/edit`.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LoadingState } from "@/design-system";
import { supabase } from "@/integrations/supabase/client";
import { AdminAppCatalogForm, type PlatformAppRecord } from "./AdminAppCatalogForm";

export default function AdminAppCatalogEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [app, setApp] = useState<PlatformAppRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    (async () => {
      const { data, error } = await (supabase.from("platform_apps") as any)
        .select("*")
        .eq("id", id)
        .single();
      if (error || !data) {
        navigate("/admin-management/app-catalog", { replace: true });
        return;
      }
      setApp(data as PlatformAppRecord);
      setLoading(false);
    })();
  }, [id, navigate]);

  if (loading || !app) return <LoadingState />;
  return <AdminAppCatalogForm app={app} />;
}
