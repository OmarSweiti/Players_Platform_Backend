import type { Locale } from './error-codes';

/**
 * The language to answer in: Arabic or English, whichever `Accept-Language`
 * weighs higher (the first listed, on a tie), else English. Once requests
 * carry a tenant context (0.4.3), its locale comes first.
 */
export function localeOf(acceptLanguage: string | undefined): Locale {
  let best: Locale = 'en';
  let bestWeight = 0;
  // At most 32 ranges are read: a header is bounded, and so is this work.
  for (const range of (acceptLanguage ?? '').split(',', 32)) {
    const [tag = '', ...parameters] = range.toLowerCase().split(';');
    const language = tag.trim().split('-')[0];
    if (language !== 'ar' && language !== 'en') continue;
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    if (weight > bestWeight) {
      best = language;
      bestWeight = weight;
    }
  }
  return best;
}
