/**
 * Shared utility for resolving user display names across the app.
 * 
 * Prevents raw email prefixes (e.g. "fredrickmureti612") from appearing
 * as user names by detecting suspect employee names and falling back
 * to profile.full_name or user_metadata.full_name.
 */

interface EmployeeLike {
  first_name: string;
  last_name: string;
  email?: string | null;
}

interface ProfileLike {
  full_name: string | null;
}

interface UserLike {
  email?: string;
  user_metadata?: { full_name?: string };
}

/**
 * Returns true if the name looks like an email prefix rather than a real name.
 * Heuristic: all lowercase/digits, no spaces, and optionally matches the user's email prefix.
 */
function looksLikeEmailPrefix(name: string, userEmail?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  // Real names typically have uppercase or spaces
  if (/^[a-z0-9._-]+$/.test(trimmed)) {
    // Extra confirmation: does it match the email prefix?
    if (userEmail) {
      const emailPrefix = userEmail.split("@")[0]?.toLowerCase();
      if (trimmed.toLowerCase() === emailPrefix) return true;
    }
    // Even without email match, a name that's all lowercase+digits with no spaces is suspect
    if (!/\s/.test(trimmed) && /\d/.test(trimmed)) return true;
  }
  return false;
}

export function getDisplayName(
  employee: EmployeeLike | null | undefined,
  profile: ProfileLike | null | undefined,
  user: UserLike | null | undefined
): { displayName: string; firstName: string; initials: string } {
  // 1. Try employee name (if it looks like a real name)
  if (employee) {
    const empFullName = `${employee.first_name || ""} ${employee.last_name || ""}`.trim();
    if (empFullName && !looksLikeEmailPrefix(employee.first_name, user?.email)) {
      return {
        displayName: empFullName,
        firstName: employee.first_name,
        initials: `${employee.first_name?.[0] || ""}${employee.last_name?.[0] || ""}`.toUpperCase() || "U",
      };
    }
  }

  // 2. Try profile full_name
  if (profile?.full_name?.trim()) {
    const name = profile.full_name.trim();
    return {
      displayName: name,
      firstName: name.split(/\s+/)[0],
      initials: name.split(/\s+/).map(n => n[0]).join("").toUpperCase().slice(0, 2),
    };
  }

  // 3. Try user metadata
  if (user?.user_metadata?.full_name?.trim()) {
    const name = user.user_metadata.full_name.trim();
    return {
      displayName: name,
      firstName: name.split(/\s+/)[0],
      initials: name.split(/\s+/).map(n => n[0]).join("").toUpperCase().slice(0, 2),
    };
  }

  // 4. No real name found — generic fallback
  return { displayName: "User", firstName: "", initials: "U" };
}
