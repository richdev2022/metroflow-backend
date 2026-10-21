/**
 * Cross-app SSO handoff — one-time tickets that let an already-authenticated
 * user hop between the Business app (app.metricorex.com) and the Personal app
 * (personal.metricorex.com) without re-typing credentials.
 *
 * Flow:
 *   1. Source app (user logged in)  -> POST /auth/sso/ticket { purpose }
 *   2. Backend issues a random one-time ticket (sha256 stored, 90s TTL,
 *      single use, bound to the user + purpose).
 *   3. Browser redirects to  TARGET_APP/sso?ticket=...&next=/path
 *   4. Target app             -> POST /auth/sso/redeem { ticket }
 *   5. Backend returns a freshly minted session token -> target app stores it
 *      exactly like a normal login and lands on /next or the default screen.
 *
 * Tickets are single-use and short-lived; the sha256 (never the raw value) is
 * persisted so a DB leak cannot mint sessions. Redeem attempts are throttled
 * by the same login-security limiter used for OTP verification.
 */

import crypto from "crypto";
import { query } from "../db";

export type SsoPurpose = "personal" | "business";

const TICKET_TTL_MS = 90_000;

export async function ensureSsoSchema(): Promise<void> {
    await query(`
    CREATE TABLE IF NOT EXISTS auth_sso_tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_hash VARCHAR(64) UNIQUE NOT NULL,
      user_id UUID NOT NULL,
      purpose VARCHAR(20) NOT NULL,
      ip VARCHAR(64),
      used_at TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_sso_tickets_user ON auth_sso_tickets(user_id, created_at DESC)`);
    // Housekeeping: drop burnt/expired rows older than a day.
    await query(`DELETE FROM auth_sso_tickets WHERE expires_at < NOW() - INTERVAL '1 day'`);
}

export async function createSsoTicket(
    userId: string,
    purpose: SsoPurpose,
    ip?: string | null,
): Promise<{ ticket: string; expires_in: number }> {
    const ticket = crypto.randomBytes(32).toString("base64url");
    const ticketHash = crypto.createHash("sha256").update(ticket).digest("hex");
    await query(
        `INSERT INTO auth_sso_tickets (ticket_hash, user_id, purpose, ip, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
        [ticketHash, userId, purpose, ip || null, String(Math.ceil(TICKET_TTL_MS / 1000))],
    );
    return { ticket, expires_in: Math.ceil(TICKET_TTL_MS / 1000) };
}

export interface RedeemResult {
    ok: boolean;
    userId?: string;
    purpose?: SsoPurpose;
    error?: string;
}

export async function redeemSsoTicket(ticket: string): Promise<RedeemResult> {
    if (!ticket || typeof ticket !== "string" || ticket.length > 128) {
        return { ok: false, error: "Invalid sign-in ticket" };
    }
    const ticketHash = crypto.createHash("sha256").update(ticket).digest("hex");
    // Atomic single-use claim: the UPDATE ... RETURNING only wins for the
    // first caller; concurrent replays find no row.
    const res = await query(
        `UPDATE auth_sso_tickets
         SET used_at = NOW()
         WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > NOW()
         RETURNING user_id, purpose`,
        [ticketHash],
    );
    const row = res.rows[0];
    if (!row) return { ok: false, error: "This sign-in link has expired or was already used. Please sign in again." };
    return { ok: true, userId: row.user_id, purpose: row.purpose };
}

/** Target app base URL for a purpose (env-overridable, sensible defaults). */
export function ssoTargetBase(purpose: SsoPurpose): string {
    if (purpose === "personal") {
        return (process.env.PERSONAL_APP_URL || "https://personal.metricorex.com").replace(/\/+$/, "");
    }
    return (process.env.BUSINESS_APP_URL || "https://app.metricorex.com").replace(/\/+$/, "");
}
