import { useSearchParams } from "react-router-dom";
import { ProductForm } from "./ProductForm";

export default function ProductNew() {
  const [searchParams] = useSearchParams();
  const createWithCode = searchParams.get("createWithCode") || undefined;
  return <ProductForm mode="create" initialBarcode={createWithCode} />;
}
