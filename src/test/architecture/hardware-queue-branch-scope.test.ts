/**
 * Architecture guard — Track 1 multi-branch hardware-queue scope.
 *
 * Ensures the SharedCommandQueueWorker passes the active branch id into
 * `claim_next_hardware_command` and that BusinessSaga forwards it to
 * `claim_next_business_event`. Without this, a cashier tab on branch A
 * could lease a print/drawer command queued for branch B's hardware.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("hardware queue claim is branch-scoped", () => {
  const worker = read("services/hardware/SharedCommandQueueWorker.ts");
  const saga = read("services/events/BusinessSaga.ts");
  const mount = read("components/events/BusinessSagaMount.tsx");

  it("SharedCommandQueueWorker accepts a branchId and forwards p_branch_id", () => {
    expect(worker).toMatch(/startSharedCommandQueueWorker\(\s*[\s\S]*?branchId\?:/);
    expect(worker).toMatch(/p_branch_id:\s*branchId\s*\?\?\s*null/);
  });

  it("BusinessSaga accepts a branchId and forwards p_branch_id", () => {
    expect(saga).toMatch(/branchId:\s*string\s*\|\s*null/);
    expect(saga).toMatch(/p_branch_id:\s*this\.branchId/);
  });

  it("BusinessSagaMount wires currentBranch into both workers", () => {
    expect(mount).toMatch(/useBranches\(\)/);
    expect(mount).toMatch(/new BusinessSaga\(orgId,\s*\d+,\s*branchId\)/);
    expect(mount).toMatch(/startSharedCommandQueueWorker\(orgId,\s*branchId\)/);
  });
});