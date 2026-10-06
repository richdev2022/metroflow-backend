import { glmChat, isGlmConfigured } from "./glm";

/**
 * Caption / transcript cleaning.
 *
 * Live speech-to-text (browser SpeechRecognition on web, speech_to_text on
 * mobile) emits raw ASR output: filler words ("uh", "um"), stutters, run-on
 * fragments and outright mis-hearings ("our boys into pest"). Two layers:
 *
 *   1. lightClean()  — instant, deterministic regex cleanup. Applied to every
 *      FINAL caption segment before relay + persistence so the live overlay,
 *      transcripts and reports are never raw garbage.
 *   2. aiCleanCaption() — LLM polish (fix obvious mis-hearings, keep
 *      meaning/language, no invention). Runs ASYNC after the final segment
 *      is already delivered; when it improves the text the transcript row is
 *      updated and a `caption:polished` event lets open clients refresh.
 */

const FILLERS =
  /\b(uh+|um+|uhm+|erm+|err+|hmm+|mhmm+|mm+hmm+|ah+|eh+|huh+|like\s+you\s+know|you\s+know\s+like)\b[,.]?\s*/gi;

/** Deterministic, instant cleanup — safe for real-time rendering. */
export function lightClean(input: string): string {
  let text = String(input || "");
  if (!text.trim()) return "";
  text = text.replace(/\s+/g, " ").trim();
  // Collapse immediate duplicated words ("the the", "I I") — a classic ASR
  // stutter. Keep intentional short repeats like "no no" (<= 2 repeats of
  // short words) intact.
  text = text.replace(
    /\b(\w{4,})(\s+\1\b)+/gi,
    (_m, word: string) => word,
  );
  // Standalone filler tokens at word boundaries (keep sentence flow).
  for (let i = 0; i < 3; i++) text = text.replace(FILLERS, " ");
  // Collapse repeated punctuation and dangling separators.
  text = text.replace(/([!?.,])\1{2,}/g, "$1");
  text = text.replace(/\s+([,.!?])/g, "$1");
  text = text.replace(/^[\s,;:.-]+/, "");
  // Capitalise the first letter.
  text = text.replace(/^([a-z])/, (m) => m.toUpperCase());
  return text.trim();
}

// --- AI polish ---------------------------------------------------------------

const polishCache = new Map<string, string>();
const POLISH_CACHE_MAX = 400;
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(text: string, language?: string | null): string {
  return `${language || "auto"}::${text}`;
}

function remember(key: string, value: string): string {
  if (polishCache.size >= POLISH_CACHE_MAX) {
    const oldest = polishCache.keys().next().value;
    if (oldest) polishCache.delete(oldest);
  }
  polishCache.set(key, value);
  return value;
}

/**
 * LLM polish of one final caption segment. Returns null when GLM is not
 * configured, the input is too short to be worth a round-trip, the call
 * fails/times out, or the model has nothing better than the input.
 */
export async function aiCleanCaption(
  rawText: string,
  language?: string | null,
): Promise<string | null> {
  const text = String(rawText || "").trim();
  if (text.length < 12 || !isGlmConfigured()) return null;

  const key = cacheKey(text, language);
  const cached = polishCache.get(key);
  if (cached !== undefined) return cached === text ? null : cached;

  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    try {
      const withTimeout = Promise.race([
        glmChat({
          messages: [
            {
              role: "system",
              content:
                "You repair raw speech-to-text segments from live business meetings/calls. " +
                "Fix obvious mis-hearings using context, remove filler words and stutters, " +
                "add minimal punctuation. Reply with the repaired sentence ONLY — same language, " +
                "same meaning, no commentary, no quotes. If the segment is unintelligible, " +
                "reply with the same text unchanged. Never invent new content.",
            },
            {
              role: "user",
              content: text,
            },
          ],
          temperature: 0.1,
          maxTokens: 220,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("caption polish timeout")), 8000),
        ),
      ]);
      const out = (await withTimeout || "").replace(/^["'`]+|["'`]+$/g, "").trim();
      if (!out || out.length < 2 || out.toLowerCase() === text.toLowerCase()) {
        remember(key, text);
        return null; // nothing better than input
      }
      return remember(key, out) === text ? null : out;
    } catch {
      return null; // never break captions on AI failure
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}
