import { describe, expect, it } from 'vitest';
import { notSentOf } from '../smtp-mail-transport';
import { invitationNotice } from './invitation-notice';

const values = {
  agency: 'Northwind <Sports> & Co',
  role: 'GOALKEEPER_COACH',
  link: 'https://northwind.agency.test/api/v1/auth/login?invitation=abc_DEF-123',
  expiresAt: new Date('2026-11-18T09:30:00Z'),
  timeZone: 'Asia/Amman',
} as const;

describe('the invitation notice', () => {
  it('is written in English, left to right', () => {
    const mail = invitationNotice('en', values);
    expect(mail.subject).toBe('Northwind <Sports> & Co invites you to Sadara');
    expect(mail.text).toContain('with the role of Goalkeeper Coach');
    expect(mail.text).toContain(`Accept the invitation: ${values.link}`);
    // The expiry in the tenant's zone: 09:30 UTC is 12:30 in Amman.
    expect(mail.text).toContain('18 November 2026 at 12:30');
    expect(mail.html).toContain('<html lang="en" dir="ltr">');
    expect(mail.html).toContain(`href="${values.link}"`);
  });

  it('is written in Arabic, right to left, its digits Western', () => {
    const mail = invitationNotice('ar', values);
    expect(mail.subject).toBe(
      'دعوة للانضمام إلى ⁨Northwind <Sports> & Co⁩ على صدارة',
    );
    expect(mail.text).toContain('بدور مدرب حراس المرمى');
    expect(mail.text).toContain(`اقبل الدعوة: ${values.link}`);
    expect(mail.text).toMatch(/18 نوفمبر 2026.*12:30/);
    expect(mail.html).toContain('<html lang="ar" dir="rtl">');
    expect(mail.html).toContain('<bdi>Northwind &lt;Sports&gt; &amp; Co</bdi>');
  });

  it('escapes what a tenant wrote, everywhere in its HTML', () => {
    for (const locale of ['ar', 'en'] as const) {
      const { html } = invitationNotice(locale, {
        ...values,
        agency: '<img src=x onerror=alert(1)>',
      });
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
  });
});

describe('a message the server did not take', () => {
  it('is named by its reply code, and is permanent only when refused for good', () => {
    expect(notSentOf({ responseCode: 550 })).toMatchObject({
      code: 'smtp_550',
      permanent: true,
    });
    expect(notSentOf({ responseCode: 451 })).toMatchObject({
      code: 'smtp_451',
      permanent: false,
    });
    expect(notSentOf({ code: 'ECONNECTION' })).toMatchObject({
      code: 'econnection',
      permanent: false,
    });
    expect(notSentOf({ code: 'EENVELOPE' })).toMatchObject({
      code: 'eenvelope',
      permanent: true,
    });
    // Never the server's text, which can quote the address.
    const unknown = notSentOf(
      Object.assign(new Error('550 <invitee@agency.test> unknown'), {
        code: 'not a code',
      }),
    );
    expect(unknown).toMatchObject({ code: 'mail_failed', permanent: false });
    expect(unknown.message).not.toContain('agency.test');
  });
});
