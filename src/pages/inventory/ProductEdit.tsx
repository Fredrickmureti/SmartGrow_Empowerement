import { useEffect, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { LoadingState, ErrorState } from "@/design-system";
import type { Product } from "@/hooks/useProducts";
import { ProductForm } from "./ProductForm";

export default function ProductEdit() {
  const { id } = useParams<{ id: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (error) setError(error.message);
      else setProduct((data as unknown as Product) ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return <Navigate to="/inventory-app/products" replace />;
  if (loading) return <LoadingState />;
  if (error) return <ErrorState title="Unable to load product" description={error} />;
  if (!product)
    return <ErrorState title="Product not found" description="It may have been deleted." />;

  return <ProductForm mode="edit" product={product} />;
}
