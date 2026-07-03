/**
 * ContactCreatePage — `/contacts-app/new`
 *
 * Phase-12 route replacement for the retired inline
 * "Add New Contact" Dialog in `src/pages/Contacts.tsx`. Reads an
 * optional `?type=customer|supplier` query param to preset the role.
 */
import { useSearchParams } from "react-router-dom";
import { ContactRecordForm } from "./ContactRecordForm";

export default function ContactCreatePage() {
  const [searchParams] = useSearchParams();
  const typeParam = searchParams.get("type");
  const defaultTypeFilter =
    typeParam === "customer" || typeParam === "supplier"
      ? (typeParam as "customer" | "supplier")
      : undefined;

  return (
    <ContactRecordForm
      mode="create"
      defaultTypeFilter={defaultTypeFilter}
    />
  );
}