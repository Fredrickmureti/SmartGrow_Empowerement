// D2 verification scratch — MUST trip no-raw-pdf-lib-in-edge-functions.
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
export const _probe = PDFDocument;
