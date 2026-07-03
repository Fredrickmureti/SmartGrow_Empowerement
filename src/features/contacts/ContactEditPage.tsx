/**
 * ContactEditPage — `/contacts-app/:id/edit`
 *
 * Phase-12 route replacement for the retired inline
 * "Edit Contact" Dialog in `src/pages/Contacts.tsx`. Loads the
 * target contact by id and hands off to `ContactRecordForm`.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import type { Contact } from "@/hooks/useContactsPaginated";
import { ContactRecordForm } from "./ContactRecordForm";

export default function ContactEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [contact, setContact] = useState<Contact | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!id) {
      navigate("/contacts-app", { replace: true });
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .eq("id", id)
        .single();
      if (cancelled) return;
      if (error || !data) {
        toast({
          title: "Contact not found",
          description: error ? normalizeError(error).message : undefined,
          variant: "destructive",
        });
        navigate("/contacts-app", { replace: true });
        return;
      }
      setContact(data as unknown as Contact);
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, navigate, toast]);

  if (isLoading || !contact) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <ContactRecordForm mode="edit" initialContact={contact} />;
}