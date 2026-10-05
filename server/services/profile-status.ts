import { query } from "../db";

/**
 * Profile-completion gate for first logins.
 *
 * Rules (per product spec):
 *  - ONLY business admins (owner/admin legacy roles) may edit the BUSINESS
 *    profile — they already provide business details at registration, so they
 *    never see the personal completion prompt.
 *  - Invited team members (manager/member/custom role) must complete a
 *    PERSONAL profile once: photo, name, email (read-only) and a
 *    phone number verified via OTP. They may SKIP and do it later in
 *    Settings (profile_prompt_dismissed prevents re-nagging).
 */
export interface ProfileStatus {
  role: string;
  isBusinessAdmin: boolean;
  profileCompleted: boolean;
  phoneVerified: boolean;
  profilePromptDismissed: boolean;
  requiresProfileCompletion: boolean;
  avatarUrl: string | null;
  phoneNumber: string | null;
}

export function isBusinessAdminRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export async function getProfileStatus(userId: string): Promise<ProfileStatus> {
  const fallback: ProfileStatus = {
    role: "member",
    isBusinessAdmin: false,
    profileCompleted: true,
    phoneVerified: false,
    profilePromptDismissed: false,
    requiresProfileCompletion: false,
    avatarUrl: null,
    phoneNumber: null,
  };
  try {
    const res = await query(
      `SELECT role,
              COALESCE(profile_completed, FALSE)    AS profile_completed,
              COALESCE(phone_verified, FALSE)       AS phone_verified,
              COALESCE(profile_prompt_dismissed, FALSE) AS prompt_dismissed,
              avatar_url,
              phone_number
       FROM users WHERE id = $1`,
      [userId],
    );
    if (res.rows.length === 0) return fallback;
    const row = res.rows[0];
    const role: string = row.role || "member";
    const admin = isBusinessAdminRole(role);
    const profileCompleted = admin ? true : Boolean(row.profile_completed);
    // "Skip for now" (profile_prompt_dismissed) must STICK: a member who
    // dismissed the personal prompt once is never re-routed to the completion
    // screen — requiresProfileCompletion would otherwise stay true on every
    // login and the skip button appeared broken.
    return {
      role,
      isBusinessAdmin: admin,
      profileCompleted,
      phoneVerified: Boolean(row.phone_verified),
      profilePromptDismissed: Boolean(row.prompt_dismissed),
      requiresProfileCompletion: !admin && !profileCompleted && !Boolean(row.prompt_dismissed),
      avatarUrl: row.avatar_url || null,
      phoneNumber: row.phone_number || null,
    };
  } catch (error) {
    // Columns may not exist yet on a lagging deploy — never block logins.
    console.error("[profile-status] failed, defaulting to complete:", error?.message);
    return fallback;
  }
}
