/**
 * parsePairingUrl — extract a scanner pairing token from a QR payload.
 *
 * Accepts the URL forms the desk QR generator has used over time:
 *   - https://<host>/scan/<token>          (current, 2026-06+)
 *   - https://<host>/scan#<token>          (current, fragment form)
 *   - https://<host>/pos/scan/<token>      (legacy, pre-2026-06)
 *   - https://<host>/pos/scan#<token>      (legacy, fragment form)
 *
 * Also accepts a bare token string (20+ url-safe chars) for paste/manual
 * recovery. Returns `null` for anything else.
 */

const BARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;
const PATH_RE = /^(?:\/pos)?\/scan\/([A-Za-z0-9_-]{20,})\/?$/;
const BASE_PATH_RE = /^(?:\/pos)?\/scan\/?$/;

export function parsePairingUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Bare token (manual paste / typed entry)
  if (BARE_TOKEN_RE.test(s)) return s;

  // Try URL parse — works for both absolute and fragment-bearing forms.
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  // Path form: /scan/<token> or /pos/scan/<token>
  const m = url.pathname.match(PATH_RE);
  if (m) return m[1];

  // Fragment form: /scan#<token> or /pos/scan#<token>
  if (BASE_PATH_RE.test(url.pathname)) {
    const frag = url.hash.replace(/^#/, "");
    if (BARE_TOKEN_RE.test(frag)) return frag;
  }

  return null;
}
