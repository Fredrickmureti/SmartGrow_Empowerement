/**
 * invokeLocalizationPack — single client entrypoint for the consolidated
 * `localization-pack` router edge function.
 *
 * All previously-standalone localization functions
 * (install-localization-pack, apply-localization-pack-upgrade,
 * publish-localization-pack-version, promote-pack-version,
 * propose-localization-upgrades, rollback-localization-pack-upgrade,
 * validate-localization-payload, lint-localization-pack,
 * process-localization-outbox) now dispatch through this helper.
 *
 * The `op` argument accepts either the legacy function name (for
 * grep-continuity) or the short alias (`install`, `publish-version`, …).
 * The router maps both to the same handler.
 */
import { invokeWithAuth } from "@/integrations/supabase/invokeWithAuth";

export type LocalizationOp =
  | "install-localization-pack"
  | "apply-localization-pack-upgrade"
  | "rollback-localization-pack-upgrade"
  | "validate-localization-payload"
  | "lint-localization-pack"
  | "publish-localization-pack-version"
  | "promote-pack-version"
  | "propose-localization-upgrades"
  | "process-localization-outbox";

export async function invokeLocalizationPack<TResponse = unknown, TBody extends Record<string, unknown> = Record<string, unknown>>(
  op: LocalizationOp,
  body: TBody,
): Promise<{ data: TResponse | null; error: Error | null }> {
  return await invokeWithAuth<TResponse, { op: LocalizationOp } & TBody>(
    "localization-pack",
    { body: { op, ...(body as any) } },
  );
}
