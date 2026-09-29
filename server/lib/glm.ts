/**
 * GLM (Z.ai) client — used by MetricAi and product document generation.
 *
 * Uses the free-tier models so no paid API key is required:
 *   - Chat:  glm-4.7-flash    (current free flash model on api.z.ai)
 *   - Image: cogview-3-flash  (free text-to-image model)
 *
 * IMPORTANT — free model ids age: Z.ai retired glm-4.5-flash on 2026-01-30 and
 * glm-4-flash before that. glmChat therefore never hard-fails on one id: it
 * walks a fallback chain of known-free ids, caches the last one that worked
 * for the process lifetime, and logs an actionable error for auth/quota bugs.
 *
 * The end USER never supplies a key — the platform provides it server-side via
 *   GLM_API_KEY  (or ZAI_API_KEY / Z_AI_API_KEY alias)
 * and optionally overrides the endpoint/model:
 *   GLM_API_BASE      default https://api.z.ai/api/paas/v4
 *   GLM_CHAT_MODEL    default glm-4-flash
 *   GLM_IMAGE_MODEL   default cogview-3-flash
 *
 * The chat-completions endpoint is OpenAI-compatible.
 */

const DEFAULT_API_BASE = "https://api.z.ai/api/paas/v4";
const DEFAULT_CHAT_MODEL = "glm-4.7-flash";
const DEFAULT_IMAGE_MODEL = "cogview-3-flash";

/**
 * Known-free chat model ids, newest first. Walked in order whenever the
 * current model stops working (e.g. upstream retirement).
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
  if (!key) return undefined;
  if (
    key.toUpperCase().startsWith("PASTE_") ||
    /^(your[_-]?key|placeholder|changeme|xxx+|undefined|null|test)$/i.test(key) ||
    key.length < 20
  ) {
    if (!placeholderWarned) {
      placeholderWarned = true;
      console.error(
        "[glm] GLM_API_KEY looks like a placeholder (or is too short). " +
          "MetricAi is serving 503 ai_not_configured. Get a free key at https://z.ai " +
          ".env: GLM_API_KEY=sk-...   then: pm2 restart metroflow --update-env",
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

export function getGlmApiBase(): string {
  return (process.env.GLM_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
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
  /** Explicit override (defaults to GLM_CHAT_MODEL / glm-4-flash) */
  model?: string;
}

/**
 * Chat completion via the OpenAI-compatible GLM endpoint.
 * Throws with a readable message when the key is missing or the API errors.
 *
 * Model resolution order:
 *   1. explicit `opts.model` (used verbatim, no fallback)
 *   2. previously-resolved working model (cache)
 *   3. GLM_CHAT_MODEL env, else the current free default
 *   4. remaining known-free ids (FALLBACK_CHAT_MODELS) — only when the request
 *      itself fails with a model-level error (4xx/5xx); auth (401/403) and
 *      quota (429) failures abort immediately with an actionable message.
 */
export async function glmChat(opts: GlmChatOptions): Promise<string> {
  const apiKey = getGlmApiKey();
  if (!apiKey) {
    throw new Error("GLM_API_KEY is not configured on the server");
  }

  const endpoint = `${getGlmApiBase()}/chat/completions`;
  const candidates = opts.model
    ? [opts.model]
    : Array.from(new Set([getGlmChatModel(), ...FALLBACK_CHAT_MODELS]));

  let lastError: Error | null = null;

  for (const model of candidates) {
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
      `GLM chat error (${response.status}) [model=${model}] :: ${errorText.slice(0, 300)}`,
    );

    // Account-level problems — another model id will not help.
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `${lastError.message} — the GLM key was rejected by ${getGlmApiBase()}. ` +
          `GLM_API_KEY must match the platform of GLM_API_BASE ` +
          `(z.ai keys typically start with "sk-"; open.bigmodel.cn keys look like "id.secret" ` +
          `and need GLM_API_BASE=https://open.bigmodel.cn/api/paas/v4).`,
      );
    }
    if (response.status === 429) {
      throw new Error(`${lastError.message} — GLM rate limit/quota exhausted, retry later.`);
    }

    console.warn(
      `[glm] chat model "${model}" not usable (HTTP ${response.status}) — trying next candidate...`,
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
  const endpoint = `${getGlmApiBase()}/images/generations`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024" }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`GLM image error (${response.status}): ${errorText.slice(0, 500)}`);
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
