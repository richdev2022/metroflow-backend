import crypto from "crypto";

/**
 * Guest access tokens for meetings & calls.
 *
 * Guests join via public links (no account). The backend mints a short-lived
 * HMAC token that scopes the guest to a single room (meeting or call) and is
 * accepted by the socket layer and guest-scoped REST endpoints.
 *
 * Token format: base64url(payload).base64url(hmac-sha256(payload))
 */

export interface GuestTokenPayload {
  guestId: string;
  name: string;
  scope: "meeting" | "call";
  roomId: string; // resolved room UUID
  businessId: string;
  iat: number;
  exp: number; // epoch seconds
}

function getSecret(): string {
  return process.env.JWT_SECRET || "metroflow-guest-token-fallback-secret";
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(input: string): Buffer {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function sign(data: string): string {
  return base64url(crypto.createHmac("sha256", getSecret()).update(data).digest());
}

export function generateGuestToken(params: {
  name: string;
  scope: "meeting" | "call";
  roomId: string;
  businessId: string;
  ttlMinutes?: number;
}): { token: string; payload: GuestTokenPayload } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = params.ttlMinutes ?? 6 * 60; // default 6 hours
  const payload: GuestTokenPayload = {
    guestId: `guest-${crypto.randomUUID()}`,
    name: params.name,
    scope: params.scope,
    roomId: params.roomId,
    businessId: params.businessId,
    iat: now,
    exp: now + ttl * 60,
  };
  const body = base64url(JSON.stringify(payload));
  const signature = sign(body);
  return { token: `${body}.${signature}`, payload };
}

export function verifyGuestToken(token: string): GuestTokenPayload | null {
  try {
    if (!token || typeof token !== "string" || !token.includes(".")) return null;
    const [body, signature] = token.split(".");
    if (!body || !signature) return null;

    const expectedSignature = sign(body);
    const bufA = Buffer.from(signature);
    const bufB = Buffer.from(expectedSignature);
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      return null;
    }

    const payload = JSON.parse(fromBase64url(body).toString("utf8")) as GuestTokenPayload;
    if (!payload?.guestId || !payload?.roomId || !payload?.exp) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Whether a guest token grants access to a given room.
 * `roomType` is derived from the resolved room ('call' | 'meeting').
 */
export function guestCanAccessRoom(
  payload: GuestTokenPayload | null,
  roomType: "call" | "meeting",
  resolvedRoomId: string
): boolean {
  if (!payload) return false;
  return payload.scope === roomType && payload.roomId === resolvedRoomId;
}
