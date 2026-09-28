/**
 * GLM (Z.ai) client — used by MetricAi and product document generation.
 *
 * Uses the free-tier models so no paid API key is required:
 *   - Chat:  glm-4-flash      (free, fast, multimodal-context text model)
 *   - Image: cogview-3-flash  (free text-to-image model)
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
const DEFAULT_CHAT_MODEL = "glm-4-flash";
const DEFAULT_IMAGE_MODEL = "cogview-3-flash";

export function getGlmApiKey(): string | undefined {
  return (
    process.env.GLM_API_KEY ||
    process.env.ZAI_API_KEY ||
    process.env.Z_AI_API_KEY ||
    undefined
  );
}

export function isGlmConfigured(): boolean {
  return !!getGlmApiKey();
}

export function getGlmApiBase(): string {
  return (process.env.GLM_API_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
}

export function getGlmChatModel(): string {
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
 */
export async function glmChat(opts: GlmChatOptions): Promise<string> {
  const apiKey = getGlmApiKey();
  if (!apiKey) {
    throw new Error("GLM_API_KEY is not configured on the server");
  }

  const endpoint = `${getGlmApiBase()}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model || getGlmChatModel(),
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 2048,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`GLM chat error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content || "";
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
