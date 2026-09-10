/**
 * KYC export package assembly — pure layout/manifest behaviour.
 *
 * These tests protect the two properties that matter most in a KYC package:
 * a client's files can only ever land under that client's own folder, and a
 * file that could not be retrieved is reported rather than faked.
 */
import { describe, expect, it } from "vitest";

import {
  buildBulkManifestCsv,
  buildExceptionsText,
  buildProfileJson,
  clientFolderEntries,
  clientFolderName,
  sanitizeSegment,
  summarize,
  type KycClientPackage,
  type KycClientRow,
  type KycDocumentKind,
} from "@/lib/kyc/kycExportPackage";

const encode = (text: string) => new TextEncoder().encode(text);

function client(overrides: Partial<KycClientRow> = {}): KycClientRow {
  return {
    id: "c1",
    business_id: "b1",
    branch_id: "br1",
    client_number: "CL-0001",
    full_name: "Jane Doe",
    national_id: "12345678",
    date_of_birth: "1990-01-01",
    gender: "female",
    phone: "0700000000",
    email: null,
    physical_address: "Nairobi",
    occupation: "Trader",
    business_type: "Retail",
    business_location: "Market",
    next_of_kin_name: "John Doe",
    next_of_kin_relationship: "spouse",
    next_of_kin_phone: "0711111111",
    photo_path: "b1/c1/photo.jpg",
    id_front_path: "b1/c1/id_front.jpg",
    id_back_path: null,
    kin_id_front_path: null,
    kin_id_back_path: null,
    loan_officer_id: null,
    joined_on: "2026-01-01",
    status: "active",
    completed_cycles: 1,
    notes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function pkg(row: KycClientRow): KycClientPackage {
  return {
    client: row,
    folder: clientFolderName(row),
    branchName: "Head Office",
    documents: [
      {
        kind: "photo",
        label: "Profile photo",
        exportedPath: "photo.jpg",
        originalFilename: "photo.jpg",
        byteSize: 3,
        status: "exported",
      },
      {
        kind: "id_front",
        label: "Identification — front",
        exportedPath: null,
        originalFilename: "id_front.jpg",
        byteSize: null,
        status: "unavailable",
        reason: "file not found",
      },
      {
        kind: "id_back",
        label: "Identification — back",
        exportedPath: null,
        originalFilename: null,
        byteSize: null,
        status: "not_captured",
      },
    ],
  };
}

describe("KYC export package", () => {
  it("names the folder with the client reference first", () => {
    expect(clientFolderName(client())).toBe("CL-0001_Jane-Doe");
    expect(sanitizeSegment("../../etc/passwd")).not.toContain("/");
  });

  it("places every file under the client's own folder", () => {
    const p = pkg(client());
    const files = new Map<KycDocumentKind, Uint8Array>([["photo", encode("abc")]]);
    const entries = clientFolderEntries(p, files, "2026-09-10T00:00:00Z", encode);
    for (const path of Object.keys(entries)) {
      expect(path.startsWith("CL-0001_Jane-Doe/")).toBe(true);
      expect(path).not.toContain("..");
    }
    expect(Object.keys(entries).sort()).toEqual([
      "CL-0001_Jane-Doe/client-profile.json",
      "CL-0001_Jane-Doe/client-profile.txt",
      "CL-0001_Jane-Doe/photo.jpg",
    ]);
  });

  it("never writes a placeholder for an unavailable or uncaptured file", () => {
    const p = pkg(client());
    const entries = clientFolderEntries(p, new Map(), "2026-09-10T00:00:00Z", encode);
    expect(entries["CL-0001_Jane-Doe/identification/id-front.jpg"]).toBeUndefined();
    expect(entries["CL-0001_Jane-Doe/identification/id-back.jpg"]).toBeUndefined();
  });

  it("cannot mix two clients' files into one folder", () => {
    const a = pkg(client());
    const b = pkg(client({ id: "c2", client_number: "CL-0002", full_name: "Mary Ann" }));
    const entriesA = clientFolderEntries(a, new Map([["photo", encode("a")]]), "t", encode);
    const entriesB = clientFolderEntries(b, new Map([["photo", encode("b")]]), "t", encode);
    const overlap = Object.keys(entriesA).filter((k) => k in entriesB);
    expect(overlap).toHaveLength(0);
  });

  it("reports exceptions and a partial status", () => {
    const summary = summarize([pkg(client())], {
      exportId: "KYCX-1",
      exportedAt: "2026-09-10T00:00:00Z",
      mode: "single",
      scope: {},
    });
    expect(summary.status).toBe("partial");
    expect(summary.documentsExported).toBe(1);
    expect(summary.documentsUnavailable).toBe(1);
    expect(summary.documentsNotCaptured).toBe(1);
    expect(buildExceptionsText([pkg(client())])).toContain("Identification — front");
  });

  it("lists every document, including missing ones, in the bulk manifest", () => {
    const csv = buildBulkManifestCsv([pkg(client())]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("client_reference");
    expect(csv).toContain("CL-0001_Jane-Doe/photo.jpg");
    expect(csv).toContain("unavailable");
  });

  it("keeps loan and accounting data out of the profile", () => {
    const json = buildProfileJson(pkg(client()));
    for (const forbidden of ["loan", "journal", "balance", "repayment", "password"]) {
      expect(json.toLowerCase()).not.toContain(forbidden);
    }
    expect(JSON.parse(json).client.reference).toBe("CL-0001");
  });
});
