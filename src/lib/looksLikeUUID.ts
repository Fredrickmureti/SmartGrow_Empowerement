/**
 * Back-compat shim. Helpers moved to `src/lib/recipientName.ts` (round 5)
 * so the resolver covers both DN (sales) and GR (purchases) surfaces.
 * Existing imports of `looksLikeUUID` / `resolveRecipientName` /
 * `stripDeliveryNoteSystemTokens` from this path keep working.
 */
export {
  looksLikeUUID,
  resolveRecipientName,
  resolveGoodsReceiptRecipient,
  stripDeliveryNoteSystemTokens,
} from "./recipientName";
