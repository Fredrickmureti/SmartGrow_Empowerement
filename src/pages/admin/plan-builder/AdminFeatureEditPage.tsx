import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LoadingState } from "@/design-system";
import { supabase } from "@/integrations/supabase/client";
import { AdminFeatureForm, type CatalogFeature } from "./AdminFeatureForm";

export default function AdminFeatureEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [feature, setFeature] = useState<CatalogFeature | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    (async () => {
      const { data, error } = await (supabase.from as any)("platform_feature_catalog")
        .select("*")
        .eq("id", id)
        .single();
      if (error || !data) {
        navigate("/admin-management/plan-builder", { replace: true });
        return;
      }
      setFeature(data as CatalogFeature);
      setLoading(false);
    })();
  }, [id, navigate]);

  if (loading || !feature) return <LoadingState />;
  return <AdminFeatureForm mode="edit" feature={feature} />;
}