# Client KYC Export — single client and bulk

## What exists today (verified)

- A client record (`mf_clients`, 6 rows live) holds all KYC data: client number, name, national ID, date of birth, gender, phone, email, address, occupation, business type/location, next-of-kin details, branch, loan officer, status, joined date, cycles, notes.
- KYC images are **not** in a separate documents table. Each client row stores up to five file paths — photo, ID front, ID back, next-of-kin ID front, next-of-kin ID back — pointing into a **private** file bucket (`mf-kyc`, 8 MB per file), laid out as `business/client/kind.jpg`.
- Access rules already exist and are enforced by the database: reading a client requires business access, and reading its files requires the same "clients read" permission plus branch/own-portfolio scope. Loan officers restricted to their own portfolio only see their own clients' files.
- The app has a PDF library (`pdf-lib`) and spreadsheet/CSV helpers, but **no ZIP support** anywhere.
- Audit trail: the shared `audit_logs` table (organization, business, user, action, entity, summary). No export-specific audit table.
- The clients screen (list, detail sheet with Edit) reads Supabase directly from the browser; there is one existing server-side function pattern in the codebase to follow.

## What will be built

### 1. A secure server-side export endpoint

A single new backend endpoint that produces the ZIP file. It:

- Requires the signed-in user's token; unauthenticated requests are rejected.
- Reads clients and downloads their files **as that user**, so the existing database access rules decide what can be exported. No service-role/bypass access is used, and the file bucket stays private.
- Never trusts a business or branch id sent from the browser: the business comes from the user's own access record, and the database re-checks every client and every file.
- Refuses a single-client export when the database returns no row for that id (covers cross-branch and cross-organization attempts).

### 2. Single client package

`CL-0007_Jane-Doe.zip`

```text
client-profile.pdf      readable KYC summary
client-profile.json     same data, machine readable
manifest.json           every file listed, with status
photo.jpg
identification/id-front.jpg
identification/id-back.jpg
next-of-kin/id-front.jpg
next-of-kin/id-back.jpg
```

Original stored files are copied byte-for-byte — never re-rendered or recompressed. The PDF is an added summary, not a replacement.

### 3. Bulk package

`kyc-export-2026-09-10.zip` containing `manifest.csv` (client reference, name, branch, status, document type, stored filename, exported path, result) plus one folder per client with the same structure as above.

Scope choices offered are only those the user already has: current branch filter, current status filter, or the clients currently listed/selected. The backend re-derives the client set itself from the user's permitted scope. A cap of 300 clients per run (current population is 6) with a clear message if exceeded.

### 4. Missing or unreadable files

The export completes and reports exceptions rather than failing silently: each missing file is marked in `manifest.json`/`manifest.csv` with a reason, an `exceptions.txt` is added when any exist, and the UI shows "Exported 12 clients — 3 documents could not be retrieved". No empty placeholder files, no storage paths or credentials exposed.

### 5. Audit

One entry per export in the existing `audit_logs` table: actor, time, action `exported`, entity `mf_client` (single) or `mf_client_bulk`, the client reference or the scope and client count, plus success/partial status and the export identifier. No document contents are recorded.

### 6. UI

- Client detail sheet footer: `Close` `Export KYC` `Edit client` — visible only with the manage-clients permission, with a short confirmation explaining that personal identity documents will be downloaded and that the action is logged.
- Clients page header: `Export KYC` opening a small dialog showing the scope (branch/status from the current filters) and the number of clients, then downloading the ZIP.

## Technical notes

- New backend route `src/routes/api/kyc-export.ts` (raw binary response; not under `/api/public`). Bearer token verified in the handler, then a user-scoped Supabase client performs all reads — RLS (`mf_can_scoped`) is the security boundary, matching the KYC view path exactly.
- Add `fflate` (pure JS, edge/Worker-safe) for ZIP assembly; reuse `pdf-lib` for the profile PDF. No new report/print infrastructure and no changes to the existing document-render pipeline.
- Register the generated `attachSupabaseAuth` client middleware in `src/start.ts` (currently absent) so authenticated server calls carry the token; append, do not replace existing middleware.
- Frontend: `src/apps/lending/clients/useKycExport.ts` (fetch + save file + toast summary) plus small additions to `ClientDetailSheet.tsx` and `ClientsPage.tsx`. Permission check via existing `usePermissions().can("manageClients")` for UI only.
- No database migration is required; no schema, storage or client data is modified. `audit_logs` accepts the new action/entity values as-is.

## Testing

- Unit tests (vitest) for package assembly: folder layout, manifest contents, missing-file handling, and that a client's files can only be placed under its own folder.
- PDF visual check on a generated sample.
- Read-only run against the 6 live clients — export only, no writes to client records or stored documents.
- Authorization tests: unauthenticated request rejected; single-client export of an id outside the caller's scope rejected; bulk export returns only clients the caller can already see (verified by comparing against the same RLS-backed read used by the clients list).
- Cross-branch/own-portfolio behaviour is exercised against the existing scope function rather than by creating new production users; if a second scoped test account is needed, this is called out rather than faked.

## Out of scope

No loan, accounting, banking or journal data enters the export. No KYC redesign, no bucket permission changes, no background job system.


=================IMPLEMENTATION PROGRESS/WHERE THINGS STAND===============

I got partway into the KYC export build before credits ran out.

Done so far

Audited the existing KYC setup: all client identity data lives on the client record (mf_clients), and the five KYC images (photo, ID front/back, next-of-kin ID front/back) live in the private mf-kyc file store, filed per institution and client. Access is already enforced by the database for both the records and the files, so that stays the security boundary.
Confirmed the shared activity log can record an "exported" event with scope and counts only.
Added ZIP packaging support to the project.
Wrote the package-assembly logic (folder layout per client, readable profile summary, machine-readable profile, manifest, exceptions report) and the server-side export builder that reads clients and downloads their files as the signed-in user, refuses clients outside their permitted scope, caps a bulk run at 300 clients, reports any file it could not retrieve instead of faking one, and writes the audit entry.
Not yet done / untested

The backend endpoint the browser calls, and registering the token attacher.
The "Export KYC" button on the client detail sheet and the bulk export on the Clients page.
All testing: single client, bulk, missing-file handling, and the cross-branch/cross-institution security checks.
One deviation to note: the readable profile is a text file rather than a PDF, because this project deliberately forbids PDF generation inside the app; the original files are still exported untouched.
No real client records, photos or documents were changed. Continuing this next.