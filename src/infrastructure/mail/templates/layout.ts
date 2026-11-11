import type { MailLocale } from '../mail-transport';

/** A message's three parts, as a template makes them. */
export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** `value` safe as HTML text or a quoted attribute: a tenant's name is whatever its owner typed. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An instant as the reader's language writes it, in the tenant's zone
 * (UX-007), with Western digits in both languages (01-conventions.md).
 */
export function instantIn(
  locale: MailLocale,
  at: Date,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone,
  }).format(at);
}

/**
 * The HTML of a message: its language and direction on the document, so an
 * Arabic one reads right to left, and a link isolated left to right inside
 * it. Inline styles only: mail clients drop style sheets.
 */
export function htmlDocument(
  locale: MailLocale,
  title: string,
  paragraphs: readonly string[],
  action: { readonly label: string; readonly href: string },
): string {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const font =
    locale === 'ar'
      ? "Tahoma, 'Segoe UI', Arial, sans-serif"
      : "'Segoe UI', Helvetica, Arial, sans-serif";
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px">${p}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:${font};color:#1b1f24;font-size:16px;line-height:1.6">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px" dir="${dir}">
${body}
<p style="margin:24px 0"><a href="${escapeHtml(action.href)}" style="display:inline-block;background:#0b5d3b;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0;font-size:13px;color:#57606a" dir="ltr"><bdi>${escapeHtml(action.href)}</bdi></p>
</div>
</body>
</html>
`;
}
