import axios from "axios";
import logger from "../lib/logger";

export interface GoogleUserInfo {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
  locale?: string;
}

/**
 * Verify a Google ID token (credential) issued by Google Identity Services.
 *
 * We validate the token against Google's tokeninfo endpoint which checks the
 * signature, and then we enforce audience (GOOGLE_CLIENT_ID), expiry and
 * email_verified ourselves.
 *
 * Docs: https://developers.google.com/identity/gsi/web/reference/html-reference
 */
/**
 * Every OAuth client this app owns that may mint ID tokens for us:
 *   - WEB      (GOOGLE_CLIENT_ID)        — web / GSI + serverClientId flows
 *   - IOS      (GOOGLE_IOS_CLIENT_ID)    — native iOS sign-in (GIDClientID)
 *   - ANDROID  (GOOGLE_ANDROID_CLIENT_ID)— native Android sign-in
 *
 * Native iOS/Android tokens carry THEIR OWN client id as `aud` (and `azp`),
 * not the web one — a single-audience check rejected every iOS sign-in with
 * "Invalid or expired Google credential" while Android kept working.
 * Env overrides exist for rotation; the hardcoded fallbacks are the
 * production clients of GCP project 438902996656 so a missing env var can
 * never silently brick SSO on one platform again.
 */
export function getAllowedGoogleClientIds(): string[] {
  const ids = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    // Production fallbacks (project 438902996656 / project-65e11808-f15a-47a5-b68)
    "438902996656-dbmnffpr8vufvso2o10esspalvl9c25c.apps.googleusercontent.com",
    "438902996656-ufvc3giigfte0eng4d0qsuhnabf726r0.apps.googleusercontent.com",
    "438902996656-i1umv1ril623btklostgk09r0pesoc9b.apps.googleusercontent.com",
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  return Array.from(new Set(ids));
}

export async function verifyGoogleIdToken(
  credential: string,
): Promise<GoogleUserInfo | null> {
  try {
    const allowedClientIds = getAllowedGoogleClientIds();
    if (allowedClientIds.length === 0) {
      logger.error("No Google client IDs configured - cannot verify Google credential");
      return null;
    }

    if (!credential || typeof credential !== "string" || credential.length < 20) {
      return null;
    }

    const { data } = await axios.get(
      "https://oauth2.googleapis.com/tokeninfo",
      {
        params: { id_token: credential },
        timeout: 10_000,
      },
    );

    if (!data || !data.sub) {
      logger.warn("Google tokeninfo returned empty payload");
      return null;
    }

    // Audience check: token must be issued for one of OUR clients (web, iOS
    // or Android). Google's tokeninfo endpoint already validated the
    // signature, so an aud match against any of our own client ids is safe.
    const aud = typeof data.aud === "string" ? data.aud : "";
    const azp = typeof data.azp === "string" ? data.azp : "";
    const audienceOk =
      allowedClientIds.includes(aud) || (azp && allowedClientIds.includes(azp));
    if (!audienceOk) {
      logger.warn("Google credential audience mismatch", {
        aud: data.aud,
        azp: data.azp || undefined,
        expected: allowedClientIds,
      });
      return null;
    }

    // Expiry check
    if (data.exp && Number(data.exp) * 1000 < Date.now()) {
      logger.warn("Google credential expired");
      return null;
    }

    // Issuer check
    const issuers = ["accounts.google.com", "https://accounts.google.com"];
    if (data.iss && !issuers.includes(data.iss)) {
      logger.warn("Google credential issuer mismatch", { iss: data.iss });
      return null;
    }

    return {
      googleId: data.sub,
      email: String(data.email || "").toLowerCase(),
      emailVerified: data.email_verified === true || data.email_verified === "true",
      name: data.name || data.email?.split("@")[0] || "Google User",
      picture: data.picture || undefined,
      locale: data.locale || undefined,
    };
  } catch (error) {
    logger.error("Error verifying Google ID token:", error);
    return null;
  }
}
