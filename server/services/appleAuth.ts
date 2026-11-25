import axios from "axios";
import crypto from "crypto";
import logger from "../lib/logger";

/**
 * Apple Sign-In (Guideline 4.8) — verify an Apple identity token.
 *
 * Unlike Google (whose tokeninfo endpoint does the signature check for us),
 * Apple exposes a JWKS (https://appleid.apple.com/auth/keys) and the client
 * hands us a signed RS256 JWT. We therefore verify the JWT ourselves:
 *   1. fetch + cache Apple's public keys (refreshed on TTL expiry or when a
 *      token references an unknown `kid` — Apple rotates keys occasionally),
 *   2. verify the RS256 signature with Node's built-in crypto (JWK import),
 *   3. enforce issuer (https://appleid.apple.com), audience (the iOS bundle
 *      id — com.metricorex.app, confirmed from the Runner project) and expiry.
 *
 * No extra dependencies: axios (already used for Google) + node:crypto.
 */

const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

/**
 * Every iOS bundle id allowed to sign users in. The hardcoded fallback is the
 * production Runner bundle id (ios/Runner.xcodeproj →
 * PRODUCT_BUNDLE_IDENTIFIER = com.metricorex.app); APPLE_BUNDLE_ID /
 * APPLE_BUNDLE_IDS env overrides exist for future rotations/new targets.
 */
export function getAllowedAppleBundleIds(): string[] {
  const ids = [
    process.env.APPLE_BUNDLE_ID,
    ...(process.env.APPLE_BUNDLE_IDS || "").split(","),
    // Production iOS bundle id (Metroflow-Mobile ios/Runner.xcodeproj).
    "com.metricorex.app",
  ]
    .map((id) => String(id || "").trim())
    .filter((id) => id.length > 0);
  return Array.from(new Set(ids));
}

interface AppleJwk {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
}

interface AppleTokenPayload {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean;
  aud: string;
  expiresAtMs: number | null;
}

let jwksCache: { keys: AppleJwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour — Apple keys rotate rarely; refresh hourly + on unknown kid.

async function fetchAppleJwks(force = false): Promise<AppleJwk[]> {
  if (
    !force &&
    jwksCache &&
    jwksCache.keys.length > 0 &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }
  const { data } = await axios.get(APPLE_JWKS_URL, { timeout: 10_000 });
  const keys: AppleJwk[] = Array.isArray(data?.keys) ? data.keys : [];
  if (!keys.length) throw new Error("Apple JWKS response contained no keys");
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Parse a JWK into a verify-able public key (RSA modulus n + exponent e). */
function jwkToPublicKey(jwk: AppleJwk): crypto.KeyObject {
  return crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
}

function parseBooleanClaim(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

/**
 * Verify an Apple identity token and return the authenticated Apple subject.
 * Returns null for ANY failure (bad shape, unknown kid after a forced key
 * refresh, signature mismatch, expired, wrong issuer/audience) — callers
 * answer 401 exactly like the Google flow.
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
): Promise<AppleTokenPayload | null> {
  try {
    if (!identityToken || typeof identityToken !== "string") return null;
    const parts = identityToken.split(".");
    if (parts.length !== 3) return null;

    // Unverified header/payload reads are only used to SELECT the key and to
    // pre-screen claims — the signature check below is what makes them trusted.
    let header: any;
    let payload: any;
    try {
      header = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
      payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
    } catch {
      logger.warn("Apple identity token: malformed header/payload");
      return null;
    }

    if (header?.alg !== "RS256" || !header?.kid) {
      logger.warn("Apple identity token: unsupported alg or missing kid", {
        alg: header?.alg,
      });
      return null;
    }

    // Fetch the matching key — a miss triggers ONE forced refresh so a fresh
    // Apple key rotation never bricks sign-in until the TTL lapses.
    let keys = await fetchAppleJwks();
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await fetchAppleJwks(true);
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) {
      logger.warn("Apple identity token: no matching JWKS kid", { kid: header.kid });
      return null;
    }

    // RS256 signature verification (node:crypto, no extra deps).
    const signedData = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlDecode(parts[2]);
    const signatureOk = crypto.verify(
      "RSA-SHA256",
      Buffer.from(signedData, "utf8"),
      jwkToPublicKey(jwk),
      signature,
    );
    if (!signatureOk) {
      logger.warn("Apple identity token: signature verification failed");
      return null;
    }

    // Issuer — Apple only.
    if (payload.iss !== APPLE_ISSUER) {
      logger.warn("Apple identity token: issuer mismatch", { iss: payload.iss });
      return null;
    }

    // Audience — OUR iOS bundle id(s).
    const allowedBundles = getAllowedAppleBundleIds();
    const aud = typeof payload.aud === "string" ? payload.aud : "";
    if (!aud || !allowedBundles.includes(aud)) {
      logger.warn("Apple identity token: audience mismatch", {
        aud,
        expected: allowedBundles,
      });
      return null;
    }

    // Expiry (60s clock-skew leeway — Apple tokens are minted client-side).
    const exp = Number(payload.exp);
    if (Number.isFinite(exp) && exp * 1000 < Date.now() - 60_000) {
      logger.warn("Apple identity token: expired");
      return null;
    }

    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) {
      logger.warn("Apple identity token: missing subject");
      return null;
    }

    return {
      sub,
      email:
        typeof payload.email === "string" && payload.email.includes("@")
          ? payload.email.toLowerCase()
          : null,
      emailVerified:
        payload.email == null ? false : parseBooleanClaim(payload.email_verified),
      isPrivateEmail: typeof payload.email === "string" && payload.email.endsWith("@privaterelay.appleid.com"),
      aud,
      expiresAtMs: Number.isFinite(exp) ? exp * 1000 : null,
    };
  } catch (error) {
    logger.error("Error verifying Apple identity token:", error);
    return null;
  }
}
