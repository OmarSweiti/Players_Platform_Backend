import type { UserRole } from '@prisma/client';
import type { InvitationNoticeValues } from '../invitation-notice';
import {
  escapeHtml,
  htmlDocument,
  instantIn,
  type RenderedMail,
} from '../layout';

/** Each role's name, as an English-speaking invitee reads it. */
export const ROLE_EN: Record<UserRole, string> = {
  SUPER_ADMIN: 'Platform Administrator',
  OWNER: 'Owner',
  ADMIN: 'Administrator',
  SPORTING_DIRECTOR: 'Sporting Director',
  SCOUT: 'Scout',
  COACH: 'Coach',
  ASSISTANT_COACH: 'Assistant Coach',
  GOALKEEPER_COACH: 'Goalkeeper Coach',
  FITNESS_COACH: 'Fitness Coach',
  MEDICAL: 'Medical Staff',
  PHYSIOTHERAPIST: 'Physiotherapist',
  LEGAL: 'Legal',
  FINANCE_MANAGER: 'Finance Manager',
  PERFORMANCE_ANALYST: 'Performance Analyst',
  VIDEO_ANALYST: 'Video Analyst',
  TRAINING_MANAGER: 'Training Manager',
  PLAYER: 'Player',
  GUARDIAN: 'Guardian',
};

/** An invitation's notice, in English. */
export function invitationNoticeEn(v: InvitationNoticeValues): RenderedMail {
  const role = ROLE_EN[v.role];
  const expires = instantIn('en', v.expiresAt, v.timeZone);
  const subject = `${v.agency} invites you to Sadara`;
  const lines = [
    'Hello,',
    `${v.agency} has invited you to join its team on Sadara, with the role of ${role}.`,
    `This invitation expires on ${expires}.`,
    'If you do not have a Sadara account yet, you will also receive an email from Sadara’s sign-in service to verify your address and choose a password: do that first, then accept the invitation here.',
    'If you were not expecting this invitation, you can ignore this email.',
  ];
  const text = [
    ...lines.slice(0, 2),
    `Accept the invitation: ${v.link}`,
    ...lines.slice(2),
    '— Sadara',
  ].join('\n\n');
  const html = htmlDocument(
    'en',
    subject,
    [
      escapeHtml(lines[0]),
      `<strong>${escapeHtml(v.agency)}</strong> has invited you to join its team on Sadara, with the role of <strong>${escapeHtml(role)}</strong>.`,
      ...lines.slice(2).map(escapeHtml),
    ],
    { label: 'Accept the invitation', href: v.link },
  );
  return { subject, text: `${text}\n`, html };
}
