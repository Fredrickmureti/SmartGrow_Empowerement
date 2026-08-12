# ADR 0137 — FX provider credentials are server-only

Status: Accepted — 2026-08-12
Related: ADR 0136 (one FX engine)

## Context

Exchange-rate market data is ingested by the `provider-run` / `provider-test` edge functions
from third-party providers (openexchangerates, fixer, freecurrencyapi, exchangerate.host).
Provider API keys were stored in `platform_integration_connections.credentials` (JSONB) and the
admin UI selected `*`, so every platform admin's browser received the plaintext keys, held them
in React state, and echoed them back on save. Any XSS, extension, or shared screen leaked a
billable third-party credential.

## Decision

1. **Secrets never leave the database.** Column-level grants on
   `platform_integration_connections` give `authenticated` SELECT on every column *except*
   `credentials`; `service_role` (edge functions) keeps full access. INSERT/UPDATE/DELETE on the
   table are revoked from `authenticated` entirely.
2. **Non-secret provenance instead.** `credential_keys text[]` and `credentials_set_at` are
   maintained by the `sync_integration_credential_meta` trigger so the UI can show *which* fields
   are configured and *when* they were last changed — never the values.
3. **One guarded write path.** `save_integration_connection(...)` and
   `delete_integration_connection(...)` are SECURITY DEFINER, gated on `is_platform_admin`,
   validate the provider/capability pair, enforce single-active-connection, and write an
   `audit_logs` row naming the credential fields that changed.
4. **Blank means keep.** A blank credential field in the form is skipped by the merge, so an
   admin can change the refresh interval without re-typing an API key. This is the only reason
   the UI can function without ever reading a secret.

## Consequences

- The rate ingest pipeline is unchanged: edge functions read credentials with the service role.
- No client code may `select("*")` from `platform_integration_connections`; the guard test
  `src/test/architecture/provider-credential-isolation.test.ts` enforces this.
- Provider credentials are auditable: who changed which field, and when.
