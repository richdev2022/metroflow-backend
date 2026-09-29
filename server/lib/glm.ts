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
const DEFAULT_IMAGE_MODEL = "cogview-4-250304";

/**
 * Known-free chat model ids, newest first. Walked in order whenever the
 * current model stops working (retired id, transient overload, ...).
 */
const FALLBACK_CHAT_MODELS = ["glm-4.5-flash", "glm-4-flash"];

/**
 * Image model candidates, newest first. Live-verified 2026-09: cogview-3-flash
 * (the old free default) is RETIRED on both z.ai and open.bigmodel.cn (code
 * 1211); cogview-4-250304 exists but needs account credit. When every GLM
 * candidate fails, glmImageGen falls back to the keyless free Pollinations
 * endpoint so MetricAi image generation never hard-breaks again.
 */
const IMAGE_MODEL_CANDIDATES = ["cogview-4-250304", "cogview-3-flash"];

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

export function getGlmVideoModel(): string {
  return process.env.GLM_VIDEO_MODEL || "cogvideox-3";
}

/** A message part: plain text or an image (data URL / https URL). */
export type GlmChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface GlmChatMessage {
  role: "system" | "user" | "assistant";
  /** Multimodal messages use the OpenAI-compatible parts array (vision). */
  content: string | GlmChatPart[];
}

export interface GlmChatOptions {
  messages: GlmChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Explicit override (defaults to GLM_CHAT_MODEL / glm-4.7-flash) */
  model?: string;
  /**
   * Enable the model's hidden reasoning pass. Default OFF — it multiplies
   * latency (6-16s vs 1-2.4s measured) which feels broken for chat replies.
   */
  enableThinking?: boolean;
}

/**
 * 429 bodies that mean "this key has no balance/quota left" — retrying another
 * model id cannot help, only topping up or switching keys can.
 */
function isQuotaExhausted429(bodyText: string): boolean {
  return /\b1113\b|insufficient|balance|quota|arrears|recharge|余额|充值/i.test(bodyText || "");
}

/**
 * Latency: glm-4.5/4.7-flash run a hidden REASONING pass by default (measured
 * live: 6-16s with thinking vs 1-2.4s disabled for the same answer). MetricAi
 * replies are short — thinking is disabled unless a caller opts in.
 */
const GLM_THINKING_OFF = { type: "disabled" as const };

/**
 * Overload memory: models that recently returned a transient-overload 429 are
 * tried last (not skipped) so fresh processes don't pay the 429 round-trip on
 * every cold start while the overloaded model recovers.
 */
const OVERLOAD_BACKOFF_MS = 3 * 60 * 1000;
const recentOverloads = new Map<string, number>();

function markOverloaded(model: string) {
  recentOverloads.set(model, Date.now());
}

function isRecentlyOverloaded(model: string): boolean {
  const at = recentOverloads.get(model);
  if (!at) return false;
  if (Date.now() - at > OVERLOAD_BACKOFF_MS) {
    recentOverloads.delete(model);
    return false;
  }
  return true;
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

  // Recently-overloaded models go last so cold starts try a healthy model first.
  const orderedModels = opts.model
    ? models
    : [
        ...models.filter((m) => !isRecentlyOverloaded(m)),
        ...models.filter((m) => isRecentlyOverloaded(m)),
      ];

  const bases = getGlmApiBases();
  let lastError: Error | null = null;
  let sawAuthRejection = false;

  for (const base of bases) {
    let baseRejected = false;

    for (const model of orderedModels) {
      if (baseRejected) break; // auth is key-level: no model id will fix it

      const endpoint = `${base}/chat/completions`;
      const postChat = (includeThinking: boolean) =>
        fetch(endpoint, {
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
            ...(includeThinking ? { thinking: opts.enableThinking ? { type: "enabled" } : GLM_THINKING_OFF } : {}),
          }),
        });

      let response: Response;
      try {
        response = await postChat(true);
        // Very old/strict endpoints may reject the thinking field outright —
        // retry that candidate once without it before moving on.
        if (response.status === 400 && /thinking/i.test(await response.clone().text().catch(() => ""))) {
          console.warn(`[glm] endpoint rejected thinking param — retrying ${model} without it...`);
          response = await postChat(false);
        }
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
        markOverloaded(model);
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

/* ------------------------------------------------------------------ */
/* VISION / OCR — "look at an image and reason about it"               */
/* ------------------------------------------------------------------ */

/**
 * Vision candidates, best-first. All are OpenAI-compatible chat/completions:
 *   1. glm-4.5v (Zhipu) — excellent OCR, but needs account credit; a 429
 *      balance error skips it in ~100ms so trying it first is cheap when the
 *      account HAS credit, and harmless when it does not.
 *   2. OpenAI gpt-4o-mini — used when OPENAI_API_KEY is configured on the VPS.
 *   3. Pollinations "openai" — FREE, keyless, always available (verified live).
 * The chain means MetricAi image understanding NEVER hard-fails.
 */
const VISION_GLM_MODEL = process.env.GLM_VISION_MODEL || "glm-4.5v";

function isOpenAiConfigured(): boolean {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  return key.length > 30 && !isPlaceholderValue(key);
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 45_000): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function extractChatContent(text: string): string {
  try {
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("").trim();
    }
    if (data?.error) throw new Error(data.error?.message || JSON.stringify(data.error).slice(0, 200));
    throw new Error("no content in response");
  } catch (e: any) {
    throw new Error(`vision parse failed: ${String(e?.message || e).slice(0, 160)}`);
  }
}

export interface GlmVisionInput {
  buffer: Buffer;
  mimeType: string;
  /** Optional secondary question focused on the user's actual message. */
  question?: string;
}

const OCR_PROMPT =
  "You are the vision system of MetricAi, an assistant inside the Metricorex business platform. " +
  "Analyze this image exhaustively for the assistant that will answer the user.\n" +
  "1. If the image contains text, transcribe ALL of it verbatim (OCR), preserving layout that matters.\n" +
  "2. Describe the key visual elements (people, UI screens, charts, documents, error messages, handwriting...).\n" +
  "3. Note anything directly relevant to the user's accompanying message.\n" +
  "Be factual and complete — the assistant can only see what you report.";

/**
 * Understand an image (OCR + scene understanding) and return a textual report
 * for the chat model. Walks glm-4.5v -> OpenAI -> Pollinations. Throws only
 * when EVERY provider fails.
 */
export async function glmVision(input: GlmVisionInput): Promise<string> {
  const { buffer, mimeType } = input;
  const safeMime = /^image\//.test(mimeType) ? mimeType : "image/png";
  const b64 = buffer.toString("base64");
  const dataUrl = `data:${safeMime};base64,${b64}`;
  const userQuestion = (input.question || "").slice(0, 2000);
  const prompt = userQuestion ? `${OCR_PROMPT}\n\nUSER'S MESSAGE: "${userQuestion}"` : OCR_PROMPT;
  const contentParts = [
    { type: "image_url", image_url: { url: dataUrl } },
    { type: "text", text: prompt },
  ];
  const errors: string[] = [];

  // 1) GLM glm-4.5v on the key's platform (cheap skip when balance is empty)
  if (isGlmConfigured()) {
    for (const base of getGlmApiBases()) {
      try {
        const r = await postJson(`${base}/chat/completions`, {
          model: VISION_GLM_MODEL,
          messages: [{ role: "user", content: contentParts }],
          max_tokens: 1400,
          stream: false,
        }, { Authorization: `Bearer ${getGlmApiKey()}` }, 40_000);
        if (r.ok) return extractChatContent(r.text);
        errors.push(`glm(${base}) HTTP ${r.status}: ${r.text.slice(0, 120)}`);
        if (r.status === 401 || r.status === 403) break; // key-level: skip other base
      } catch (e: any) {
        errors.push(`glm(${base}): ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  }

  // 2) OpenAI (VPS may have OPENAI_API_KEY configured)
  if (isOpenAiConfigured()) {
    try {
      const r = await postJson("https://api.openai.com/v1/chat/completions", {
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
        messages: [{ role: "user", content: contentParts }],
        max_tokens: 1400,
      }, { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || "").trim()}` }, 40_000);
      if (r.ok) return extractChatContent(r.text);
      errors.push(`openai HTTP ${r.status}: ${r.text.slice(0, 120)}`);
    } catch (e: any) {
      errors.push(`openai: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  // 3) Pollinations (free, keyless — verified live 2026-09)
  try {
    const r = await postJson("https://text.pollinations.ai/openai", {
      model: "openai",
      messages: [{ role: "user", content: contentParts }],
      referrer: "metricorex",
    }, { Referer: "https://metricorex.com" }, 60_000);
    if (r.ok) return extractChatContent(r.text);
    errors.push(`pollinations HTTP ${r.status}: ${r.text.slice(0, 120)}`);
  } catch (e: any) {
    errors.push(`pollinations: ${String(e?.message || e).slice(0, 120)}`);
  }

  throw new Error(`All vision providers failed: ${errors.join(" | ").slice(0, 500)}`);
}

/** Fetch image bytes from a URL with a timeout. */
async function downloadImage(url: string, timeoutMs = 120000): Promise<{ buffer: Buffer; mimeType: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get("content-type") || "image/png",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keyless FREE image fallback (Pollinations — donations-funded, no account,
 * no key). Guarantees MetricAi can always produce an image even when every
 * GLM cogview candidate is retired or the GLM account has no credit.
 */
async function pollinationsImageGen(
  prompt: string,
  upload: (buffer: Buffer, mimeType: string, originalname: string) => Promise<string>,
): Promise<GlmImageResult> {
  const seed = Math.floor(Math.random() * 1_000_000);
  const endpoint =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}` +
    `?width=1024&height=1024&nologo=true&seed=${seed}`;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { buffer, mimeType } = await downloadImage(endpoint, 120000);
      if (buffer.length < 1024) throw new Error("suspiciously small response");
      const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
      const url = await upload(buffer, mimeType, `metricai-${Date.now()}.${ext}`);
      return { url, model: "pollinations-free" };
    } catch (e: any) {
      lastError = new Error(`Pollinations attempt ${attempt} failed: ${e?.message || e}`);
      console.warn(`[glm] ${lastError.message}`);
    }
  }
  throw lastError || new Error("Pollinations image generation failed");
}

let imageCreditWarned = false;

/**
 * Text-to-image with a resilient chain:
 *   1. GLM cogview candidates (env GLM_IMAGE_MODEL -> cogview-4-250304 ->
 *      cogview-3-flash) across every platform endpoint (key-format aware).
 *      Retired ids (1211/404) and credit-less accounts (1113/429) fall through.
 *   2. Keyless free Pollinations fallback — always available, zero config.
 * The API returns either a short-lived hosted URL or base64 — we always
 * download/decode and re-upload through our own storage chain so the link we
 * hand to clients never expires.
 */
export async function glmImageGen(
  prompt: string,
  upload: (buffer: Buffer, mimeType: string, originalname: string) => Promise<string>,
): Promise<GlmImageResult> {
  const models = Array.from(
    new Set([getGlmImageModel(), ...IMAGE_MODEL_CANDIDATES]),
  );
  const apiKey = getGlmApiKey();
  let lastError: Error | null = null;

  if (apiKey) {
    for (const base of getGlmApiBases()) {
      let baseRejected = false;

      for (const model of models) {
        if (baseRejected) break;
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
          console.warn(`[glm] image network error on ${base} — trying next candidate...`);
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => response.statusText);
          lastError = new Error(`GLM image error (${response.status}): ${errorText.slice(0, 500)}`);
          if (response.status === 401 || response.status === 403) {
            baseRejected = true; // key-level: try the other platform endpoint
            continue;
          }
          if (/1211|not exist|Unknown Model|1113|Insufficient balance|余额|充值|insufficient/i.test(errorText)) {
            // retired id or no credit — the fallback chain handles both
            if (!imageCreditWarned && /1113|Insufficient balance|余额|充值|insufficient/i.test(errorText)) {
              imageCreditWarned = true;
              console.warn(
                "[glm] GLM image models need account credit (cogview-4-250304). " +
                  "Using the free keyless fallback until the GLM account is topped up.",
              );
            }
            console.warn(`[glm] image model "${model}" unavailable on ${base} — trying next candidate...`);
            continue;
          }
          throw lastError;
        }

        try {
          const data = (await response.json()) as {
            data?: Array<{ url?: string; b64_json?: string }>;
          };
          const item = data.data?.[0];
          if (!item) {
            lastError = new Error("GLM image response contained no image");
            continue;
          }
          let buffer: Buffer;
          let mimeType = "image/png";
          if (item.b64_json) {
            buffer = Buffer.from(item.b64_json, "base64");
          } else if (item.url) {
            const dl = await downloadImage(item.url);
            buffer = dl.buffer;
            mimeType = dl.mimeType;
          } else {
            lastError = new Error("GLM image response contained neither url nor b64_json");
            continue;
          }
          const url = await upload(buffer, mimeType, `metricai-${Date.now()}.png`);
          return { url, model };
        } catch (e: any) {
          lastError = e instanceof Error ? e : new Error(String(e));
          console.warn(`[glm] image candidate "${model}" on ${base} failed: ${lastError.message}`);
        }
      }
    }
  }

  // Every GLM candidate failed (or no key) — the free keyless fallback.
  console.warn("[glm] all GLM image candidates failed — falling back to free Pollinations endpoint");
  try {
    return await pollinationsImageGen(prompt, upload);
  } catch (pollError) {
    console.error("[glm] Pollinations fallback also failed:", pollError);
    throw (
      lastError ||
      (pollError instanceof Error ? pollError : new Error("image generation failed"))
    );
  }
}

export interface GlmVideoJob {
  /** Upstream async job id (bigmodel/z.ai style) */
  jobId: string;
  /** Platform base the job was created on (polling must hit the same base) */
  base: string;
  model: string;
  status: string;
}

export interface GlmVideoStatus {
  status: "processing" | "success" | "failed";
  videoUrl?: string;
  coverUrl?: string;
  raw?: string;
}

function videoError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Create an async text-to-video job (CogVideoX). PAID on GLM: if the account
 * has no credit the upstream answers 1113 — surfaced as a coded error so
 * callers can show an actionable message instead of a generic failure.
 */
export async function glmVideoCreate(prompt: string): Promise<GlmVideoJob> {
  const apiKey = getGlmApiKey();
  if (!apiKey) throw videoError("video_not_configured", "GLM_API_KEY is not configured on the server");

  const model = getGlmVideoModel();
  let lastError: Error | null = null;

  for (const base of getGlmApiBases()) {
    let response: Response;
    try {
      response = await fetch(`${base}/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt: prompt.slice(0, 2000), quality: "quality", fps: 30 }),
      });
    } catch (networkError: any) {
      lastError = networkError instanceof Error ? networkError : new Error(String(networkError));
      continue;
    }

    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        id?: string; task_status?: string;
      };
      if (data.id) {
        return { jobId: data.id, base, model, status: data.task_status || "PROCESSING" };
      }
      lastError = new Error("GLM video response contained no job id");
      continue;
    }

    const errorText = await response.text().catch(() => response.statusText);
    if (/1113|Insufficient balance|余额|充值|no resource package|insufficient/i.test(errorText)) {
      throw videoError(
        "video_requires_credit",
        "Video generation runs on the paid CogVideoX model and the GLM account " +
          "currently has no credit/resource pack. Top up at " +
          (base.includes("bigmodel") ? "https://open.bigmodel.cn" : "https://z.ai") +
          " (image generation stays free — it uses a keyless fallback).",
      );
    }
    if (response.status === 401 || response.status === 403) continue; // try other platform
    if (/1211|not exist|Unknown Model/i.test(errorText)) {
      lastError = videoError("video_model_unavailable", `Video model "${model}" is not available on ${base}.`);
      continue;
    }
    lastError = new Error(`GLM video error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  throw (
    lastError ||
    videoError("video_unavailable", "Video generation is unavailable right now.")
  );
}

/**
 * Poll an async video job. Must be polled on the SAME base that created it.
 * Returns normalized status; the video URL is present only on success.
 */
export async function glmVideoPoll(jobId: string, base: string): Promise<GlmVideoStatus> {
  const apiKey = getGlmApiKey();
  if (!apiKey) throw videoError("video_not_configured", "GLM_API_KEY is not configured on the server");

  const res = await fetch(`${base}/videos/generations/${encodeURIComponent(jobId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => res.statusText);
    throw new Error(`GLM video poll error (${res.status}): ${errorText.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as {
    task_status?: string;
    video_result?: Array<{ url?: string; cover_image_url?: string }>;
  };
  const rawStatus = (data.task_status || "PROCESSING").toUpperCase();
  if (rawStatus === "SUCCESS") {
    const item = data.video_result?.[0];
    if (!item?.url) return { status: "failed", raw: "success without video_result" };
    return { status: "success", videoUrl: item.url, coverUrl: item.cover_image_url };
  }
  if (rawStatus === "FAIL") return { status: "failed", raw: "upstream reported FAIL" };
  return { status: "processing", raw: rawStatus };
}
