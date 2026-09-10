/**
 * Client KYC export — package layout and manifest assembly.
 *
 * Pure, dependency-free helpers shared by the server export builder and its
 * unit tests. This module owns the KYC boundary: only identity/profile fields
 * and the five stored KYC images that `mf_clients` actually holds. No loan,
 * accounting, banking or internal system data is ever placed in a package.
 */

/** The KYC image kinds stored on `mf_clients` (private `mf-kyc` bucket). */
export const KYC_DOCUMENTS = [
  { kind: "photo", label: "Profile photo", column: "photo_path", zipPath: "photo.jpg" },
  {
    kind: "id_front",
    label: "Identification — front",
    column: "id_front_path",
    zipPath: "identification/id-front.jpg",
  },
  {
    kind: "id_back",
    label: "Identification — back",
    column: "id_back_path",
    zipPath: "identification/id-back.jpg",
  },
  {
    kind: "kin_id_front",
    label: "Next of kin identification — front",
    column: "kin_id_front_path",
    zipPath: "next-of-kin/id-front.jpg",
  },
  {
    kind: "kin_id_back",
    label: "Next of kin identification — back",
    column: "kin_id_back_path",
    zipPath: "next-of-kin/id-back.jpg",
  },
] as const;

export type KycDocumentKind = (typeof KYC_DOCUMENTS)[number]["kind"];

/**
 * Exactly the columns that belong to the KYC/profile record. Deliberately
 * excludes loan, fee, accounting and internal columns.
 */
export const KYC_CLIENT_COLUMNS = [
  "id",
  "business_id",
  "branch_id",
  "client_number",
  "full_name",
  "national_id",
  "date_of_birth",
  "gender",
  "phone",
  "email",
  "physical_address",
  "occupation",
  "business_type",
  "business_location",
  "next_of_kin_name",
  "next_of_kin_relationship",
  "next_of_kin_phone",
  "photo_path",
  "id_front_path",
  "id_back_path",
  "kin_id_front_path",
  "kin_id_back_path",
  "loan_officer_id",
  "joined_on",
  "status",
  "completed_cycles",
  "notes",
  "created_at",
  "updated_at",
] as const;

export interface KycClientRow {
  id: string;
  business_id: string;
  branch_id: string;
  client_number: string;
  full_name: string;
  national_id: string | null;
  date_of_birth: string | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  physical_address: string | null;
  occupation: string | null;
  business_type: string | null;
  business_location: string | null;
  next_of_kin_name: string | null;
  next_of_kin_relationship: string | null;
  next_of_kin_phone: string | null;
  photo_path: string | null;
  id_front_path: string | null;
  id_back_path: string | null;
  kin_id_front_path: string | null;
  kin_id_back_path: string | null;
  loan_officer_id: string | null;
  joined_on: string;
  status: string;
  completed_cycles: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface KycDocumentResult {
  kind: KycDocumentKind;
  label: string;
  /** Path inside the client folder; null when nothing was written. */
  exportedPath: string | null;
  /** Original stored filename (last storage path segment). */
  originalFilename: string | null;
  byteSize: number | null;
  status: "exported" | "not_captured" | "unavailable";
  /** Human-readable reason when the file could not be retrieved. */
  reason?: string;
}

export interface KycClientPackage {
  client: KycClientRow;
  folder: string;
  branchName: string | null;
  documents: KycDocumentResult[];
}

/** Filesystem-safe path segment (no slashes, no traversal, ASCII-ish). */
export function sanitizeSegment(value: string): string {
  const cleaned = (value ?? "")
    .replace(/[^\w.\- ]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned || "client";
}

/** `CL-0007_Jane-Doe` — the client reference always leads, so the folder is unambiguous. */
export function clientFolderName(client: Pick<KycClientRow, "client_number" | "full_name">): string {
  return `${sanitizeSegment(client.client_number)}_${sanitizeSegment(client.full_name)}`;
}

/** Machine-readable profile. */
export function buildProfileJson(pkg: KycClientPackage): string {
  const c = pkg.client;
  return `${JSON.stringify(
    {
      kind: "client_kyc_profile",
      version: 1,
      client: {
        reference: c.client_number,
        full_name: c.full_name,
        status: c.status,
        joined_on: c.joined_on,
        completed_cycles: c.completed_cycles,
        identification: { national_id: c.national_id },
        personal: { date_of_birth: c.date_of_birth, gender: c.gender },
        contact: {
          phone: c.phone,
          email: c.email,
          physical_address: c.physical_address,
        },
        livelihood: {
          occupation: c.occupation,
          business_type: c.business_type,
          business_location: c.business_location,
        },
        next_of_kin: {
          name: c.next_of_kin_name,
          relationship: c.next_of_kin_relationship,
          phone: c.next_of_kin_phone,
        },
        assignment: { branch: pkg.branchName, branch_id: c.branch_id, business_id: c.business_id },
        notes: c.notes,
        record_created_at: c.created_at,
        record_updated_at: c.updated_at,
      },
      documents: pkg.documents.map((d) => ({
        kind: d.kind,
        label: d.label,
        exported_path: d.exportedPath,
        original_filename: d.originalFilename,
        byte_size: d.byteSize,
        status: d.status,
        ...(d.reason ? { reason: d.reason } : {}),
      })),
    },
    null,
    2,
  )}\n`;
}

const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

/** Human-readable profile summary kept alongside the original files. */
export function buildProfileText(pkg: KycClientPackage, exportedAt: string): string {
  const c = pkg.client;
  const line = (label: string, value: unknown) => `  ${label.padEnd(24)}${dash(value)}`;
  return [
    "CLIENT KYC RECORD",
    "=================",
    `  ${"Client reference".padEnd(24)}${c.client_number}`,
    line("Full name", c.full_name),
    line("Status", c.status),
    line("Joined on", c.joined_on),
    line("Completed cycles", c.completed_cycles),
    "",
    "IDENTIFICATION",
    line("National ID", c.national_id),
    line("Date of birth", c.date_of_birth),
    line("Gender", c.gender),
    "",
    "CONTACT",
    line("Phone", c.phone),
    line("Email", c.email),
    line("Physical address", c.physical_address),
    "",
    "LIVELIHOOD",
    line("Occupation", c.occupation),
    line("Business type", c.business_type),
    line("Business location", c.business_location),
    "",
    "NEXT OF KIN",
    line("Name", c.next_of_kin_name),
    line("Relationship", c.next_of_kin_relationship),
    line("Phone", c.next_of_kin_phone),
    "",
    "ASSIGNMENT",
    line("Branch", pkg.branchName),
    "",
    "NOTES",
    `  ${dash(c.notes)}`,
    "",
    "KYC FILES IN THIS PACKAGE",
    ...pkg.documents.map(
      (d) =>
        `  ${d.label.padEnd(34)}${
          d.status === "exported"
            ? d.exportedPath
            : d.status === "not_captured"
              ? "not captured"
              : `UNAVAILABLE — ${d.reason ?? "could not be retrieved"}`
        }`,
    ),
    "",
    `Exported ${exportedAt}`,
    "",
  ].join("\n");
}

export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const BULK_MANIFEST_HEADER = [
  "client_reference",
  "client_name",
  "branch",
  "client_status",
  "document_kind",
  "document_label",
  "original_filename",
  "exported_path",
  "byte_size",
  "result",
  "reason",
];

/** One row per document (including missing ones) so the package is auditable. */
export function buildBulkManifestCsv(packages: KycClientPackage[]): string {
  const rows = [BULK_MANIFEST_HEADER.join(",")];
  for (const pkg of packages) {
    for (const d of pkg.documents) {
      rows.push(
        [
          pkg.client.client_number,
          pkg.client.full_name,
          pkg.branchName,
          pkg.client.status,
          d.kind,
          d.label,
          d.originalFilename,
          d.exportedPath ? `${pkg.folder}/${d.exportedPath}` : "",
          d.byteSize,
          d.status,
          d.reason ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return `${rows.join("\n")}\n`;
}

export interface KycExportSummary {
  exportId: string;
  exportedAt: string;
  mode: "single" | "bulk";
  clientCount: number;
  documentsExported: number;
  documentsUnavailable: number;
  documentsNotCaptured: number;
  status: "success" | "partial";
  scope: Record<string, unknown>;
}

export function summarize(
  packages: KycClientPackage[],
  base: Pick<KycExportSummary, "exportId" | "exportedAt" | "mode" | "scope">,
): KycExportSummary {
  let exported = 0;
  let unavailable = 0;
  let notCaptured = 0;
  for (const pkg of packages) {
    for (const d of pkg.documents) {
      if (d.status === "exported") exported += 1;
      else if (d.status === "unavailable") unavailable += 1;
      else notCaptured += 1;
    }
  }
  return {
    ...base,
    clientCount: packages.length,
    documentsExported: exported,
    documentsUnavailable: unavailable,
    documentsNotCaptured: notCaptured,
    status: unavailable > 0 ? "partial" : "success",
  };
}

/** Exceptions report, added only when at least one file could not be retrieved. */
export function buildExceptionsText(packages: KycClientPackage[]): string | null {
  const lines: string[] = [];
  for (const pkg of packages) {
    for (const d of pkg.documents) {
      if (d.status === "unavailable") {
        lines.push(
          `${pkg.client.client_number} — ${pkg.client.full_name}: ${d.label} could not be retrieved (${d.reason ?? "unknown error"})`,
        );
      }
    }
  }
  if (lines.length === 0) return null;
  return [
    "KYC EXPORT EXCEPTIONS",
    "=====================",
    "The following KYC files are recorded on the client but could not be retrieved.",
    "No placeholder or substitute file was written for them.",
    "",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Builds the ZIP entry map for one client folder. Every path is forced under
 * the client's own folder so one client's file can never land in another's.
 */
export function clientFolderEntries(
  pkg: KycClientPackage,
  files: Map<KycDocumentKind, Uint8Array>,
  exportedAt: string,
  encode: (text: string) => Uint8Array,
): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const put = (relative: string, bytes: Uint8Array) => {
    const safe = relative.replace(/^\/+/, "").replace(/\.\.+/g, ".");
    out[`${pkg.folder}/${safe}`] = bytes;
  };
  put("client-profile.txt", encode(buildProfileText(pkg, exportedAt)));
  put("client-profile.json", encode(buildProfileJson(pkg)));
  for (const doc of pkg.documents) {
    const bytes = files.get(doc.kind);
    if (doc.status === "exported" && doc.exportedPath && bytes) put(doc.exportedPath, bytes);
  }
  return out;
}
