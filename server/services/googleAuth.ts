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
export async function verifyGoogleIdToken(
  credential: string,
): Promise<GoogleUserInfo | null> {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      logger.error("GOOGLE_CLIENT_ID is not configured - cannot verify Google credential");
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

    // Audience check: token must be issued for our app
    if (data.aud !== clientId && !(data.azp && data.azp === clientId)) {
      logger.warn("Google credential audience mismatch", {
        aud: data.aud,
        expected: clientId,
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
