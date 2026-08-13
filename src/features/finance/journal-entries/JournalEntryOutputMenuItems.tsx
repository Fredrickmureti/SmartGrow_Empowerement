/**
 * Row-level output items for the Journal Entries list. Renders the SAME
 * `useJournalEntryActions` vocabulary the record page and peek sheet use,
 * as dropdown items so it can sit inside the existing lifecycle menu.
 */
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useJournalEntryActions } from "./useJournalEntryActions";

export function JournalEntryOutputMenuItems({
  entry,
}: {
  entry: { id: string; entry_number?: string | null };
}) {
  const actions = useJournalEntryActions(entry);
  return (
    <>
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <DropdownMenuItem
            key={action.id}
            disabled={action.disabled}
            onSelect={(event) => {
              event.preventDefault();
              action.onSelect();
            }}
          >
            {Icon ? <Icon className="mr-2 h-4 w-4" /> : null}
            {action.label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

export default JournalEntryOutputMenuItems;
