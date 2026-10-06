import { Request, Response, NextFunction } from "express";
import {
  isPayloadEncryptionEnabled,
  looksLikeEncryptedEnvelope,
  decryptJson,
  encryptJson,
} from "../lib/payload-crypto";

/**
 * Payload-encryption middleware — installed AFTER express.json / body
 * recovery and BEFORE the router (server/index.ts).
 *
 * Request: when the client sent `x-mfv-enc: 1` and the parsed body is an
 * encrypted envelope, `req.body` is replaced with the decrypted plaintext.
 * Response: when the client opted in, `res.json` is wrapped so every JSON
 * response (success AND error paths — both call res.json) leaves the server
 * as an envelope, and `x-mfv-enc: 1` is stamped on the response so the
 * client knows to decrypt.
 *
 * Bypass (never encrypted, both directions):
 *   - requests without the `x-mfv-enc: 1` header
 *   - multipart/form-data + raw uploads (files)
 *   - provider webhooks (raw-body signature verification)
 *   - health/ping/docs/static
 */
const BYPASS_PATH_RE =
  /^\/(health|ping|api-docs|uploads|webhook|demo|test-sentry)(\/|$)|^\/api\/(health|ping|api-docs|uploads|webhook|demo|test-sentry)(\/|$)/i;

declare module "express-serve-static-core" {
  interface Request {
    mfvEnc?: {
      /** Client opted in — responses must be encrypted. */
      active: boolean;
      /** The incoming request body arrived encrypted. */
      encryptedRequest: boolean;
      /** Plaintext of the request body, stashed for the request logger. */
      plaintextBody?: unknown;
      /** Plaintext of the response body, stashed by the res.json wrapper. */
      plaintextResponse?: unknown;
    };
  }
}

export function payloadEncryptionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const wantsEnc = req.headers["x-mfv-enc"] === "1";
  const contentType = String(req.headers["content-type"] || "");
  const isMultipart = contentType.includes("multipart/form-data");
  const method = req.method.toUpperCase();

  // Global bypass: client has no key, server has no key, or the path is
  // infrastructure/webhook/static territory.
  const globalBypass =
    !wantsEnc ||
    !isPayloadEncryptionEnabled() ||
    BYPASS_PATH_RE.test(req.originalUrl || req.url || "") ||
    method === "OPTIONS";

  // Request decryption additionally skips bodyless methods and uploads.
  const requestBypass = globalBypass || method === "GET" || method === "HEAD" || isMultipart;

  // RESPONSES are encrypted for every method — a GET /wallet response with
  // balances must be ciphertext just as much as a POST /transfers body.
  const responseActive = !globalBypass;

  req.mfvEnc = { active: responseActive, encryptedRequest: false };

  // ---- Request decryption -------------------------------------------------
  if (!requestBypass && req.body !== undefined && req.body !== null && looksLikeEncryptedEnvelope(req.body)) {
    try {
      const plaintext = decryptJson<any>(req.body as any);
      req.body = plaintext;
      req.mfvEnc.encryptedRequest = true;
    } catch (err: any) {
      res.setHeader("x-mfv-enc", "1");
      res.status(400).json({
        success: false,
        error: "Unable to decrypt request payload",
        code: "DECRYPT_FAILED",
      });
      return;
    }
  }

  if (responseActive) {
    req.mfvEnc.plaintextBody = req.body;
  }

  // ---- Response encryption ------------------------------------------------
  if (responseActive) {
    res.setHeader("x-mfv-enc", "1");
    const originalJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      // Express's res.send delegates plain objects to res.json, and res.json
      // calls res.send internally — either wrapper may therefore receive an
      // already-encrypted envelope. Skip it: exactly one wrap, always.
      if (looksLikeEncryptedEnvelope(body)) {
        return originalJson(body);
      }
      try {
        if (req.mfvEnc) req.mfvEnc.plaintextResponse = body;
        return originalJson(encryptJson(body ?? null));
      } catch {
        // Never fail a response because encryption hiccupped.
        return originalJson(body);
      }
    };
    // Some legacy routes answer via res.send(obj) instead of res.json(obj) —
    // wrap send as well so those responses are not plaintext leaks. Express's
    // res.json delegates to res.send internally, so the send wrapper MUST
    // skip already-encrypted envelopes (no double wrap) plus binary/string
    // payloads (files, HTML, plain text).
    const originalSend = res.send.bind(res);
    (res as any).send = (body: any) => {
      const wrappable =
        body !== null &&
        body !== undefined &&
        typeof body === "object" &&
        !Buffer.isBuffer(body) &&
        !(body instanceof Uint8Array) &&
        !looksLikeEncryptedEnvelope(body);
      if (!wrappable) {
        return originalSend(body);
      }
      try {
        if (req.mfvEnc && req.mfvEnc.plaintextResponse === undefined) {
          req.mfvEnc.plaintextResponse = body;
        }
        return originalSend(encryptJson(body));
      } catch {
        return originalSend(body);
      }
    };
  }

  next();
}
