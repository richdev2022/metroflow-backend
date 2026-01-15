import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

type AIProvider = "openai" | "google";

const getProvider = (): AIProvider => {
  const configured = process.env.AI_PROVIDER as AIProvider | undefined;
  if (configured === "openai" || configured === "google") return configured;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY) return "google";
  return "openai";
};

export async function generateProductDocumentation(title: string, description: string): Promise<string> {
  const prompt = `
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

  const provider = getProvider();
  console.log(`Generating documentation using provider: ${provider}`);

  try {
    if (provider === "google") {
      const googleAi = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY });
      const result = await googleAi.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });
      return result.text || "";
    } else {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not set");
      }
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "gpt-4o",
      });
      return completion.choices[0].message.content || "";
    }
  } catch (error) {
    console.error(`${provider} AI Error:`, error);
    if (error instanceof Error) {
        console.error("Error Message:", error.message);
        console.error("Error Stack:", error.stack);
    }
    throw error;
  }
}

export async function regenerateProductDocumentation(
  currentContent: string,
  areasOfConcern: string
): Promise<string> {
  const prompt = `
    Update the following product documentation based on the areas of concern.
    
    Current Documentation:
    ${currentContent}
    
    Areas of Concern:
    ${areasOfConcern}
    
    Return the updated documentation in Markdown.
  `;

  const provider = getProvider();
  console.log(`Regenerating documentation using provider: ${provider}`);

  try {
    if (provider === "google") {
        const googleAi = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_KEY || process.env.GEMINI_API_KEY });
        const result = await googleAi.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
        });
        return result.text || "";
    } else {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not set");
      }
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "gpt-4o",
      });
      return completion.choices[0].message.content || "";
    }
  } catch (error) {
    console.error(`${provider} AI Error:`, error);
    if (error instanceof Error) {
        console.error("Error Message:", error.message);
        console.error("Error Stack:", error.stack);
    }
    throw error;
  }
}
