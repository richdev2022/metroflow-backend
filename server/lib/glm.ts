/**
 * GLM (Z.ai / Zhipu) client — used by MetricAi and product document generation.
 *
 * Uses the free-tier models so no paid API key is required:
 *   - Chat:  glm-4.7-flash    (current free flash model)
 *   - Image: cogview-3-flash  (free text-to-image model)
 *
 * IMPORTANT — free model ids age: glm-4.5-flash was retired on z.ai 2026-01-30
 * and glm-4-flash before that, while BOTH still exist on open.bigmodel.cn.
 * glmChat therefore never hard-fails on one id: it walks a fallback chain of
 * known-free ids, caches the last one that worked for the process lifetime,
 * and logs an actionable error for auth/quota bugs.
 *
 * KEY FORMAT AUTO-DETECTION — both Zhipu platforms are supported out of the box:
 *   - "sk-..."                -> https://api.z.ai/api/paas/v4
 *   - "id.secret" (e.g. hex.alnum) -> https://open.bigmodel.cn/api/paas/v4
 *   - GLM_API_BASE env always wins. If a base rejects the key (401/403) the
 *     other platform endpoint is tried before giving up.
 *
 * 429 POLICY — rate limits are classified:
 *   - balance/quota exhaustion (code 1113, "insufficient balance", ...) aborts
 *     immediately: every model on this key would fail the same way.
 *   - transient overload (code 1305, "访问量过大" / "overloaded") falls through
 *     to the next free model — verified live: glm-4.7-flash can sit at 429 for
 *     hours while glm-4.5-flash answers instantly on the same key.
 *
 * The end USER never supplies a key — the platform provides it server-side via
 *   GLM_API_KEY  (or ZAI_API_KEY / Z_AI_API_KEY alias)
 * and optionally overrides the endpoint/model:
 *   GLM_API_BASE      default auto-detected from the key format
 *   GLM_CHAT_MODEL    default glm-4.7-flash
 *   GLM_IMAGE_MODEL   default cogview-3-flash
 *
 * The chat-completions endpoint is OpenAI-compatible.
 */

import { isPlaceholderValue } from "./config-flags";

export const ZAI_API_BASE = "https://api.z.ai/api/paas/v4";
export const BIGMODEL_API_BASE = "https://open.bigmodel.cn/api/paas/v4";

const DEFAULT_API_BASE = ZAI_API_BASE;
const DEFAULT_CHAT_MODEL = "glm-4.7-flash";
const DEFAULT_IMAGE_MODEL = "cogview-3-flash";

/**
 * Known-free chat model ids, newest first. Walked in order whenever the
 * current model stops working (retired id, transient overload, ...).
 */
const FALLBACK_CHAT_MODELS = ["glm-4.5-flash", "glm-4-flash"];

/** Chat model id that last answered OK (process lifetime cache). */
let resolvedChatModel: string | null = null;

export function getGlmApiKey(): string | undefined {
  const raw =
    process.env.GLM_API_KEY ||
    process.env.ZAI_API_KEY ||
    process.env.Z_AI_API_KEY ||
    "";
  const key = raw.trim();
  // Treat obvious placeholder/invalid values as "not configured" so callers get
  // the clean 503 ai_not_configured path instead of a guaranteed upstream 401.
  if (!key || isPlaceholderValue(key) || key.length < 20) {
    if (key && !placeholderWarned) {
      placeholderWarned = true;
      console.error(
        "[glm] GLM_API_KEY looks like a placeholder (or is too short). " +
          "MetricAi is serving 503 ai_not_configured. Get a free key at https://z.ai " +
          "(key starts with sk-) or https://open.bigmodel.cn (key looks like id.secret). " +
          ".env: GLM_API_KEY=...   then: pm2 restart metroflow --update-env",
      );
    }
    return undefined;
  }
  return key;
}

let placeholderWarned = false;

export function isGlmConfigured(): boolean {
  return !!getGlmApiKey();
}

/**
 * Guess the platform endpoint from the key format:
 *   sk-...             -> z.ai international
 *   "id.secret" pair   -> open.bigmodel.cn (Zhipu China)
 * Anything else falls back to z.ai.
 */
export function detectGlmBaseFromKey(key: string): string {
  const k = (key || "").trim();
  if (k.startsWith("sk-")) return ZAI_API_BASE;
  if (/^[a-z0-9]{12,64}\.[a-z0-9]{8,64}$/i.test(k)) return BIGMODEL_API_BASE;
  return DEFAULT_API_BASE;
}

/**
 * Ordered list of endpoints to try: explicit GLM_API_BASE wins, then the base
 * detected from the key format, then the other known platform as last resort.
 */
export function getGlmApiBases(): string[] {
  const envBase = (process.env.GLM_API_BASE || "").trim().replace(/\/+$/, "");
  const key = getGlmApiKey() || "";
  const detected = key ? detectGlmBaseFromKey(key) : DEFAULT_API_BASE;
  return Array.from(new Set([envBase, detected, ZAI_API_BASE, BIGMODEL_API_BASE].filter(Boolean)));
}

/** Primary endpoint (kept for backwards-compatible logging / image gen). */
export function getGlmApiBase(): string {
  return getGlmApiBases()[0];
}

export function getGlmChatModel(): string {
  if (resolvedChatModel) return resolvedChatModel;
  return process.env.GLM_CHAT_MODEL || DEFAULT_CHAT_MODEL;
}

export function getGlmImageModel(): string {
  return process.env.GLM_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}

export interface GlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GlmChatOptions {
  messages: GlmChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Explicit override (defaults to GLM_CHAT_MODEL / glm-4.7-flash) */
  model?: string;
}

/**
 * 429 bodies that mean "this key has no balance/quota left" — retrying another
 * model id cannot help, only topping up or switching keys can.
 */
function isQuotaExhausted429(bodyText: string): boolean {
  return /\b1113\b|insufficient|balance|quota|arrears|recharge|余额|充值/i.test(bodyText || "");
}

/**
 * Chat completion via the OpenAI-compatible GLM endpoint.
 * Throws with a readable message when the key is missing or the API errors.
 *
 * Candidate space is (endpoint x model), walked in order:
 *   endpoints: GLM_API_BASE env, key-format detection, other platform fallback
 *   models:    explicit opts.model (verbatim, no walk) | cached winner |
 *              GLM_CHAT_MODEL env | current free default | known-free ids
 *
 * Abort conditions (no further candidates):
 *   - key rejected by EVERY known endpoint (401/403)
 *   - 429 whose body indicates balance/quota exhaustion
 * Fall-through conditions (try next candidate):
 *   - network error, retired/unknown model (400/404), transient overload 429,
 *     any other model-level error
 */
export async function glmChat(opts: GlmChatOptions): Promise<string> {
  const apiKey = getGlmApiKey();
  if (!apiKey) {
    throw new Error("GLM_API_KEY is not configured on the server");
  }

  const models = opts.model
    ? [opts.model]
    : Array.from(new Set([getGlmChatModel(), ...FALLBACK_CHAT_MODELS]));

  const bases = getGlmApiBases();
  let lastError: Error | null = null;
  let sawAuthRejection = false;

  for (const base of bases) {
    let baseRejected = false;

    for (const model of models) {
      if (baseRejected) break; // auth is key-level: no model id will fix it

      const endpoint = `${base}/chat/completions`;
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: opts.messages,
            temperature: opts.temperature ?? 0.7,
            max_tokens: opts.maxTokens ?? 2048,
            stream: false,
          }),
        });
      } catch (networkError: any) {
        lastError = new Error(
          `GLM chat network error (${endpoint}): ${networkError?.message || networkError}`,
        );
        console.warn(`[glm] network error on model ${model} — trying next candidate...`);
        continue;
      }

      if (response.ok) {
        if (!opts.model) resolvedChatModel = model;
        try {
          const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          return data.choices?.[0]?.message?.content || "";
        } catch (parseError: any) {
          throw new Error(
            `GLM chat returned malformed JSON: ${parseError?.message || parseError}`,
          );
        }
      }

      const errorText = await response.text().catch(() => response.statusText);
      lastError = new Error(
        `GLM chat error (${response.status}) [base=${base} model=${model}] :: ${errorText.slice(0, 300)}`,
      );

      if (response.status === 401 || response.status === 403) {
        baseRejected = true;
        sawAuthRejection = true;
        console.warn(`[glm] key rejected by ${base} — trying next platform endpoint...`);
        continue;
      }

      if (response.status === 429) {
        if (isQuotaExhausted429(errorText)) {
          throw new Error(
            `${lastError.message} — GLM account balance/quota exhausted for this key. ` +
              `Top up at the key's platform, or use a free flash model key.`,
          );
        }
        // 1305 / "overloaded" / transient traffic limits — the next free model
        // usually answers immediately (verified live on production keys).
        console.warn(`[glm] chat model "${model}" overloaded on ${base} — trying next candidate...`);
        continue;
      }

      console.warn(
        `[glm] chat model "${model}" not usable on ${base} (HTTP ${response.status}) — trying next candidate...`,
      );
    }
  }

  if (lastError && sawAuthRejection) {
    lastError = new Error(
      `${lastError.message} — the GLM key was rejected by every known endpoint. ` +
        `GLM_API_KEY must match its platform (z.ai keys start with "sk-"; ` +
        `open.bigmodel.cn keys look like "id.secret"), or set GLM_API_BASE explicitly.`,
    );
  }

  throw lastError || new Error("GLM chat failed: no model candidates");
}

export interface GlmImageResult {
  /** Persistent URL (uploaded through our storage chain) */
  url: string;
  model: string;
}

/**
 * Text-to-image via the free CogView model. The API returns either a
 * short-lived hosted URL or base64 — we always download/decode and re-upload
 * through our own storage chain so the link we hand to clients never expires.
 * Walks the same platform endpoints as glmChat (key-format detection).
 */
export async function glmImageGen(
  prompt: string,
  upload: (buffer: Buffer, mimeType: string, originalname: string) => Promise<string>,
): Promise<GlmImageResult> {
  const apiKey = getGlmApiKey();
  if (!apiKey) {
    throw new Error("GLM_API_KEY is not configured on the server");
  }

  const model = getGlmImageModel();
  let lastError: Error | null = null;

  for (const base of getGlmApiBases()) {
    const endpoint = `${base}/images/generations`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024" }),
      });
    } catch (networkError: any) {
      lastError = new Error(
        `GLM image network error (${endpoint}): ${networkError?.message || networkError}`,
      );
      console.warn(`[glm] image network error on ${base} — trying next endpoint...`);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      lastError = new Error(`GLM image error (${response.status}): ${errorText.slice(0, 500)}`);
      // Auth is key-level: the other platform endpoint may accept this key.
      if (response.status === 401 || response.status === 403) continue;
      throw lastError;
    }

    const data = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const item = data.data?.[0];
    if (!item) throw new Error("GLM image response contained no image");

    let buffer: Buffer;
    let mimeType = "image/png";
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, "base64");
    } else if (item.url) {
      const imgRes = await fetch(item.url);
      if (!imgRes.ok) throw new Error(`Failed to download generated image (${imgRes.status})`);
      mimeType = imgRes.headers.get("content-type") || "image/png";
      buffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error("GLM image response contained neither url nor b64_json");
    }

    const url = await upload(buffer, mimeType, `metricai-${Date.now()}.png`);
    return { url, model };
  }

  throw lastError || new Error("GLM image generation failed: no endpoints available");
}
