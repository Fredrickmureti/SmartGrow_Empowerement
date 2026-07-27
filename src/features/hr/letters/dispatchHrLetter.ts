/**
 * dispatchHrLetter — the single exit for pushing an HR letter into the
 * document engine.
 *
 * Wave 7.2. HR letters are signed instruments: an offer someone accepted, a
 * contract someone is employed under, a warning that may be produced at a
 * tribunal. The legacy path re-fetched the source row at print time, so a
 * reprint two years later could quietly reflect a renamed job title or a
 * corrected salary. Here the letter is frozen into a snapshot at dispatch
 * time, archived as a document record, and every subsequent copy is a
 * reproduction of that record rather than a fresh interpretation of the data.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  fetchAndBuildHrLetterSnapshot,
  HR_LETTER_KIND_CODES,
  type HrLetterType,
} from "@/services/documents/snapshots/hrLetter";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { submitDocumentIntent } from "@/services/documents/submitIntent";

/** `documents.source_doc_type` per letter — the row the letter was cut from. */
const SOURCE_DOC_TYPE: Record<HrLetterType, string> = {
  offer_letter: "offer_letter",
  contract_letter: "employee_contract",
  promotion_letter: "employee_lifecycle_event",
  warning_letter: "employee_lifecycle_event",
};

export interface DispatchHrLetterArgs {
  letterType: HrLetterType;
  /** Primary key of the source row (offer, contract, or lifecycle event). */
  sourceId: string;
  /** Tenancy fallbacks, used only when the snapshot cannot resolve them. */
  organizationId?: string | null;
  businessId?: string | null;
  triggeredSource?: "manual" | "business_event" | "reprint" | "api";
}

export interface DispatchHrLetterResult {
  documentRecordId: string;
  targetCount: number;
}

export async function dispatchHrLetter({
  letterType,
  sourceId,
  organizationId,
  businessId,
  triggeredSource = "manual",
}: DispatchHrLetterArgs): Promise<DispatchHrLetterResult> {
  const built = await fetchAndBuildHrLetterSnapshot(supabase, letterType, sourceId);

  // Tenancy is not optional: an unrouted letter would land in no archive.
  const orgId = built.organizationId ?? organizationId ?? null;
  if (!orgId) {
    throw new Error(
      `Cannot dispatch ${letterType}: source row ${sourceId} has no organization.`,
    );
  }

  const documentRecordId = await ensureDocumentRecord({
    kindCode: HR_LETTER_KIND_CODES[letterType],
    organizationId: orgId,
    sourceModule: "hr",
    sourceDocType: SOURCE_DOC_TYPE[letterType],
    sourceDocId: sourceId,
    businessId: built.businessId ?? businessId ?? null,
    branchId: null,
    // Offers precede employment: there is no employee party to bind to yet.
    partyKind: built.partyKind,
    partyId: built.partyId,
    currency: null,
    documentNumber: built.documentNumber,
    documentDate: built.documentDate,
    snapshot: built.snapshot,
  });

  const result = await submitDocumentIntent({ documentRecordId, triggeredSource });

  return { documentRecordId, targetCount: result.target_count };
}
