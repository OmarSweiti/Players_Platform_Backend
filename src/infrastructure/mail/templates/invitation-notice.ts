import type { UserRole } from '@prisma/client';
import type { MailLocale } from '../mail-transport';
import { invitationNoticeAr } from './ar/invitation-notice';
import { invitationNoticeEn } from './en/invitation-notice';
import type { RenderedMail } from './layout';

/** What an invitation's notice says: who invites, to what role, where to accept, until when. */
export interface InvitationNoticeValues {
  /** The tenant's name, as its owner wrote it. */
  readonly agency: string;
  readonly role: UserRole;
  /** The link that accepts it, with its single-use token (0.5.10). */
  readonly link: string;
  readonly expiresAt: Date;
  /** The tenant's IANA zone, which the expiry is written in. */
  readonly timeZone: string;
}

/** The template's name, as a delivery records it. */
export const INVITATION_NOTICE = 'invitation-notice';

const BY_LOCALE: Record<
  MailLocale,
  (values: InvitationNoticeValues) => RenderedMail
> = {
  ar: invitationNoticeAr,
  en: invitationNoticeEn,
};

/** An invitation's notice, in the invitee's language (0.7.8). */
export function invitationNotice(
  locale: MailLocale,
  values: InvitationNoticeValues,
): RenderedMail {
  return BY_LOCALE[locale](values);
}
