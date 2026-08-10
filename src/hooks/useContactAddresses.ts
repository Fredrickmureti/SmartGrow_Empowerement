/**
 * useContactAddresses — the ONE React read path for a party's addresses.
 *
 * A thin react-query wrapper over `listPartyAddresses` (ADR-0038 / ADR-0080).
 * It deliberately owns no SQL and no formatting: the canonical resolver in
 * `@/lib/contactAddresses` remains the single source of truth, this hook only
 * gives UI surfaces a cached, invalidatable handle on it.
 *
 * The query key is `["party-addresses", contactId]` — the exact key
 * `ContactAddressBook` already invalidates after a write, so every consumer
 * refreshes on the same business event without extra plumbing.
 */
import { useQuery } from "@tanstack/react-query";
import {
  listPartyAddresses,
  type PartyAddress,
} from "@/lib/contactAddresses";

export function useContactAddresses(contactId: string | null | undefined) {
  const { data, isLoading } = useQuery({
    queryKey: ["party-addresses", contactId],
    queryFn: () => listPartyAddresses(contactId),
    enabled: !!contactId,
  });

  return {
    addresses: (data ?? []) as PartyAddress[],
    isLoading: !!contactId && isLoading,
  };
}
