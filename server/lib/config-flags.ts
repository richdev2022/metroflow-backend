/**
 * Shared env-flag helpers: placeholder detection so the app treats
 * "PASTE_TENOR_KEY_HERE"-style values as NOT configured instead of
 * reporting green and failing at request time.
 */

const PLACEHOLDER_WORDS =
  /^(your[_-]?key|paste|placeholder|changeme|xxx+|undefined|null|test|todo|fixme)$/i;

/**
 * True when a value is empty or an obvious placeholder.
 * Placeholders are values like "PASTE_KEY_FROM_ZAI_HERE" / "changeme".
 */
export function isPlaceholderValue(value: string | undefined | null): boolean {
  const v = (value || "").trim();
  if (!v) return true;
  const upper = v.toUpperCase();
  if (upper.startsWith("PASTE_") || upper.endsWith("_HERE")) return true;
  return PLACEHOLDER_WORDS.test(v);
}

/** Tenor GIF API key (server-side only), or undefined when absent/placeholder. */
export function getTenorApiKey(): string | undefined {
  const key = (process.env.TENOR_API_KEY || "").trim();
  return isPlaceholderValue(key) ? undefined : key;
}

export function isTenorConfigured(): boolean {
  return !!getTenorApiKey();
}
