import type { UserRole } from '@prisma/client';
import type { InvitationNoticeValues } from '../invitation-notice';
import {
  escapeHtml,
  htmlDocument,
  instantIn,
  type RenderedMail,
} from '../layout';

/** Each role's name, as an Arabic-speaking invitee reads it. */
export const ROLE_AR: Record<UserRole, string> = {
  SUPER_ADMIN: 'مسؤول المنصة',
  OWNER: 'المالك',
  ADMIN: 'المسؤول',
  SPORTING_DIRECTOR: 'المدير الرياضي',
  SCOUT: 'الكشّاف',
  COACH: 'المدرب',
  ASSISTANT_COACH: 'المدرب المساعد',
  GOALKEEPER_COACH: 'مدرب حراس المرمى',
  FITNESS_COACH: 'مدرب اللياقة البدنية',
  MEDICAL: 'الطاقم الطبي',
  PHYSIOTHERAPIST: 'أخصائي العلاج الطبيعي',
  LEGAL: 'الشؤون القانونية',
  FINANCE_MANAGER: 'المدير المالي',
  PERFORMANCE_ANALYST: 'محلل الأداء',
  VIDEO_ANALYST: 'محلل الفيديو',
  TRAINING_MANAGER: 'مدير التدريب',
  PLAYER: 'اللاعب',
  GUARDIAN: 'ولي الأمر',
};

/**
 * An invitation's notice, in Arabic. The agency's name is isolated (`<bdi>`,
 * and U+2068…U+2069 in plain text), so a Latin name sits in the sentence
 * without reordering it.
 */
export function invitationNoticeAr(v: InvitationNoticeValues): RenderedMail {
  const role = ROLE_AR[v.role];
  const expires = instantIn('ar', v.expiresAt, v.timeZone);
  const agency = `⁨${v.agency}⁩`;
  const subject = `دعوة للانضمام إلى ${agency} على صدارة`;
  const lines = [
    'مرحبًا،',
    `تمت دعوتك للانضمام إلى فريق ${agency} على منصة صدارة، بدور ${role}.`,
    `تنتهي صلاحية هذه الدعوة في ${expires}.`,
    'إن لم يكن لديك حساب في صدارة بعد، فستصلك أيضًا رسالة من خدمة تسجيل الدخول في صدارة لتأكيد عنوان بريدك الإلكتروني واختيار كلمة مرور: أكمِل ذلك أولًا، ثم اقبل الدعوة من هنا.',
    'إن لم تكن تتوقع هذه الدعوة، فيمكنك تجاهل هذه الرسالة.',
  ];
  const text = [
    ...lines.slice(0, 2),
    `اقبل الدعوة: ${v.link}`,
    ...lines.slice(2),
    '— صدارة',
  ].join('\n\n');
  const html = htmlDocument(
    'ar',
    subject,
    [
      escapeHtml(lines[0]),
      `تمت دعوتك للانضمام إلى فريق <strong><bdi>${escapeHtml(v.agency)}</bdi></strong> على منصة صدارة، بدور <strong>${escapeHtml(role)}</strong>.`,
      ...lines.slice(2).map(escapeHtml),
    ],
    { label: 'اقبل الدعوة', href: v.link },
  );
  return { subject, text: `${text}\n`, html };
}
