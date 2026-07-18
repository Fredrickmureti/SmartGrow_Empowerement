/**
 * ContactCustomFieldsPanel — renders Studio-defined custom fields for a
 * Contact (party record) inside the Supplier 360 workbench.
 *
 * Read-only display. Field authoring and value editing happen in the
 * Contact edit route (`/contacts/:id/edit`) — this panel only surfaces
 * the configured fields + current values so procurement can see them
 * in the supplier record without hopping back to Contacts.
 *
 * Per ADR-0079 the Supplier is the role and Contact is the party, so
 * `entity_type='contact'` is the canonical custom-field slot for both.
 */
import { EmptyState } from "@/design-system";
import { useEntityFields, useEntityFieldValues } from "@/hooks/useEntityFields";

export function ContactCustomFieldsPanel({ contactId }: { contactId: string }) {
  const { visibleFields, isLoading: cfgLoading } = useEntityFields("contact");
  const { getFieldValue, isLoading: valLoading } = useEntityFieldValues(
    "contact",
    contactId,
  );

  if (cfgLoading || valLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading custom fields…</p>
    );
  }

  if (visibleFields.length === 0) {
    return (
      <EmptyState
        title="No custom fields configured"
        description="Define contact custom fields in Studio to have them appear here."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {visibleFields.map((f) => {
        const value = getFieldValue(f.field_key);
        return (
          <div key={f.id} className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {f.field_label}
              {f.is_required && <span className="ml-1 text-destructive">*</span>}
            </div>
            <div className="mt-1 text-sm">
              {value == null || value === "" ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                value
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
