/**
 * RFQ Phase 4b — supplier bid attachments.
 *
 * Single access path for bid evidence, shared by the vendor portal and the
 * buyer-side RFQ record. Rules enforced server-side (never here):
 *  - rows are written only by `rfq_attach_quotation_document`
 *  - rows are detached only by `rfq_remove_quotation_attachment`
 *  - both refuse anything but the live (`submitted`) quotation version and,
 *    for suppliers, refuse past the response deadline
 *  - a revised quote copies its predecessor's attachments forward, so each
 *    version keeps its own immutable evidence set
 *
 * Storage objects live in the private `rfq-bid-attachments` bucket under
 * `{rfq_id}/{quotation_id}/{uuid}-{filename}`; there is no delete/update
 * policy on purpose — detaching never erases the stored file.
 */
import { supabase } from "@/integrations/supabase/client";

const db = supabase as any;

export const RFQ_BID_BUCKET = "rfq-bid-attachments";

export const BID_ATTACHMENT_KINDS = [
  { value: "bid_document", label: "Bid document" },
  { value: "technical_spec", label: "Technical specification" },
  { value: "certificate", label: "Certificate" },
  { value: "price_list", label: "Price list" },
  { value: "other", label: "Other" },
] as const;

export type BidAttachmentKind = (typeof BID_ATTACHMENT_KINDS)[number]["value"];

export const MAX_BID_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface RFQBidAttachment {
  id: string;
  quotation_id: string;
  rfq_id: string;
  supplier_id: string;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
  attachment_kind: BidAttachmentKind;
  uploaded_via: string;
  carried_forward_from: string | null;
  created_at: string;
}

export function bidAttachmentKindLabel(kind: string) {
  return BID_ATTACHMENT_KINDS.find((k) => k.value === kind)?.label ?? "Document";
}

export function formatFileSize(bytes: number | null | undefined) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Storage keys must stay ASCII-safe; the display name is kept in the row. */
function safeObjectName(fileName: string) {
  const cleaned = fileName.replace(/[^\w.\-]+/g, "_").slice(-120);
  return `${crypto.randomUUID()}-${cleaned || "file"}`;
}

export async function listBidAttachments(quotationId: string): Promise<RFQBidAttachment[]> {
  const { data, error } = await db
    .from("rfq_quotation_attachments")
    .select("*")
    .eq("quotation_id", quotationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as RFQBidAttachment[];
}

export async function uploadBidAttachment(params: {
  rfqId: string;
  quotationId: string;
  file: File;
  kind?: BidAttachmentKind;
}): Promise<string> {
  const { rfqId, quotationId, file, kind = "bid_document" } = params;

  if (file.size > MAX_BID_ATTACHMENT_BYTES) {
    throw new Error(
      `${file.name} is larger than the ${formatFileSize(MAX_BID_ATTACHMENT_BYTES)} limit`,
    );
  }

  const path = `${rfqId}/${quotationId}/${safeObjectName(file.name)}`;

  const { error: uploadError } = await supabase.storage
    .from(RFQ_BID_BUCKET)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await db.rpc("rfq_attach_quotation_document", {
    _quotation_id: quotationId,
    _file_path: path,
    _file_name: file.name,
    _mime_type: file.type || null,
    _file_size: file.size,
    _kind: kind,
  });
  if (error) throw error;
  return data as string;
}

export async function removeBidAttachment(attachmentId: string) {
  const { error } = await db.rpc("rfq_remove_quotation_attachment", {
    _attachment_id: attachmentId,
  });
  if (error) throw error;
}

/** Private bucket: reads always go through a short-lived signed URL. */
export async function bidAttachmentUrl(filePath: string) {
  const { data, error } = await supabase.storage
    .from(RFQ_BID_BUCKET)
    .createSignedUrl(filePath, 300);
  if (error) throw error;
  return data.signedUrl;
}
