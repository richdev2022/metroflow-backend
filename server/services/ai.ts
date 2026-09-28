import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { glmChat, isGlmConfigured } from "../lib/glm";

/**
 * Product-documentation AI providers.
 *
 * AI_PROVIDER env toggles the implementation:
 *   "glm"    -> Z.ai GLM (glm-4-flash, FREE — recommended, no cost)
 *   "openai" -> OpenAI gpt-4o
 *   "google" -> Gemini 2.5 Flash
 * When AI_PROVIDER is unset the first provider WITH a configured key wins,
 * in order: glm -> openai -> google.
 */
type AIProvider = "glm" | "openai" | "google";

const PROVIDERS: AIProvider[] = ["glm", "openai", "google"];

export const getProvider = (): AIProvider => {
  const configured = process.env.AI_PROVIDER as AIProvider | undefined;
  if (configured && PROVIDERS.includes(configured)) return configured;
  if (isGlmConfigured()) return "glm";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY) return "google";
  return "glm";
};

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

async function runProvider(prompt: string, provider: AIProvider): Promise<string> {
  console.log(`Generating documentation using provider: ${provider}`);

  try {
    if (provider === "glm") {
      return await glmChat({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
        maxTokens: 4096,
      });
    }

    if (provider === "google") {
      const googleAi = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY });
      const result = await googleAi.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });
      return result.text || "";
    }

    // openai
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "gpt-4o",
    });
    return completion.choices[0].message.content || "";
  } catch (error) {
    console.error(`${provider} AI Error:`, error);
    if (error instanceof Error) {
      console.error("Error Message:", error.message);
      console.error("Error Stack:", error.stack);
    }

    // Graceful provider fallback so docs generation keeps working when one
    // provider is down or unconfigured: glm -> openai -> google.
    const fallbacks: AIProvider[] = PROVIDERS.filter((p) => p !== provider);
    for (const fallback of fallbacks) {
      // Only fall back to a provider that has credentials
      const usable =
        fallback === "glm"
          ? isGlmConfigured()
          : fallback === "openai"
            ? !!process.env.OPENAI_API_KEY
            : !!(process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY);
      if (!usable) continue;
      console.warn(`Falling back from ${provider} to ${fallback}`);
      try {
        return await runProvider(prompt, fallback);
      } catch {
        // try next
      }
    }
    throw error;
  }
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
