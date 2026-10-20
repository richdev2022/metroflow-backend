import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { glmChat, isGlmConfigured } from "../lib/glm";

/**
 * Product-documentation AI providers.
 *
 * AI_PROVIDER env toggles the primary implementation:
 *   "google" -> Gemini 2.5 Flash (primary when configured)
 *   "glm"    -> Z.ai GLM (glm-4.7-flash / flash chain — free, recommended fallback)
 *   "openai" -> OpenAI gpt-4o
 *
 * When AI_PROVIDER is unset the primary is the first provider WITH a
 * configured key, in order: google (gemini) -> glm -> openai.
 *
 * Fallback is ALWAYS enabled: if the primary fails, times out, or returns an
 * empty response, the next configured provider is tried — most importantly
 * GLM acts as the safety net whenever Gemini fails (rate limits, quota,
 * outages, safety blocks, empty candidates).
 */
type AIProvider = "glm" | "openai" | "google";

const PROVIDERS: AIProvider[] = ["google", "glm", "openai"];

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 120000);

export const getProvider = (): AIProvider => {
  const configured = process.env.AI_PROVIDER as AIProvider | undefined;
  if (configured && PROVIDERS.includes(configured)) return configured;
  if (process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY) return "google";
  if (isGlmConfigured()) return "glm";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "glm";
};

function isProviderConfigured(provider: AIProvider): boolean {
  switch (provider) {
    case "glm":
      return isGlmConfigured();
    case "openai":
      return !!process.env.OPENAI_API_KEY;
    case "google":
      return !!(process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY);
  }
}

function withTimeout<T>(promise: Promise<T>, provider: AIProvider): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${provider} AI timed out after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const DOC_PROMPT = (title: string, description: string) => `
    Generate a very detailed product documentation for the following idea:
    Title: ${title}
    Description: ${description}
    
    The documentation should include:
    1. Introduction
    2. Problem Statement
    3. Solution Overview
    4. Key Features
    5. User Stories
    6. Technical Architecture
    7. Roadmap
    8. Conclusion
    
    Format the output in Markdown.
  `;

const REGEN_PROMPT = (currentContent: string, areasOfConcern: string) => `
    Update the following product documentation based on the areas of concern.
    
    Current Documentation:
    ${currentContent}
    
    Areas of Concern:
    ${areasOfConcern}
    
    Return the updated documentation in Markdown.
  `;

/**
 * Call a single provider. Throws on transport errors, timeouts, and empty
 * responses (empty output used to be returned as success, silently skipping
 * the fallback chain — it must be treated as a failure instead).
 */
async function callProvider(prompt: string, provider: AIProvider): Promise<string> {
  console.log(`Generating documentation using provider: ${provider}`);

  let text = "";
  if (provider === "glm") {
    text = await withTimeout(
      glmChat({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
        maxTokens: 8192,
      }),
      provider,
    );
  } else if (provider === "google") {
    const googleAi = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY });
    const result = await withTimeout(
      googleAi.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      }),
      provider,
    );
    text = result.text || "";
  } else {
    // openai
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await withTimeout(
      openai.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "gpt-4o",
      }),
      provider,
    );
    text = completion.choices[0].message.content || "";
  }

  if (!text || !text.trim()) {
    throw new Error(`${provider} AI returned an empty response`);
  }
  return text;
}

/**
 * Try the preferred provider first, then walk the remaining configured
 * providers. Gemini failures (quota, outage, safety block, timeout, empty
 * candidate) transparently fall back to GLM.
 */
async function runProvider(prompt: string, preferred: AIProvider): Promise<string> {
  const chain: AIProvider[] = [preferred, ...PROVIDERS.filter((p) => p !== preferred)];

  let lastError: unknown;
  for (const provider of chain) {
    if (!isProviderConfigured(provider)) continue;
    try {
      return await callProvider(prompt, provider);
    } catch (error) {
      lastError = error;
      console.error(`${provider} AI Error:`, error);
      if (error instanceof Error) {
        console.error("Error Message:", error.message);
      }
      const remaining = chain.filter((p) => p !== provider && isProviderConfigured(p));
      if (remaining.length > 0) {
        console.warn(`Falling back from ${provider} to ${remaining[0]}`);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No AI provider is configured. Set GEMINI_API_KEY or GLM_API_KEY.");
}

export async function generateProductDocumentation(title: string, description: string): Promise<string> {
  return runProvider(DOC_PROMPT(title, description), getProvider());
}

export async function regenerateProductDocumentation(
  currentContent: string,
  areasOfConcern: string
): Promise<string> {
  return runProvider(REGEN_PROMPT(currentContent, areasOfConcern), getProvider());
}
