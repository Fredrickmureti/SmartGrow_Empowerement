/**
 * Tiny semver parser/comparator used by publish-localization-pack-version
 * to reject bad version strings and enforce strict monotonicity vs the
 * previous published version.
 *
 * Accepts: MAJOR.MINOR.PATCH and MAJOR.MINOR.PATCH-PRERELEASE
 * Rejects: anything else (alpha, banana, v1, 1.0, …).
 */
export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(v: string): ParsedSemver | null {
  if (typeof v !== "string") return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/** Returns >0 if a>b, 0 if equal, <0 if a<b. Throws on invalid input. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`Invalid semver: "${a}"`);
  if (!pb) throw new Error(`Invalid semver: "${b}"`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // Stable rule: prerelease < non-prerelease at the same triple
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (!pa.prerelease && !pb.prerelease) return 0;
  return (pa.prerelease as string).localeCompare(pb.prerelease as string);
}

export function isValidSemver(v: string): boolean {
  return parseSemver(v) !== null;
}
