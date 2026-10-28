import { describe, expect, it } from 'vitest';
import {
  detectEmailProvider,
  extractLinks,
  extractLoginCode,
  getEmailProvider,
  previewDocument,
  secureForPort,
} from './emailProviders';

describe('email providers', () => {
  it('detects presets from the saved host', () => {
    expect(detectEmailProvider('')).toBeNull();
    expect(detectEmailProvider('  ')).toBeNull();
    expect(detectEmailProvider('smtp.gmail.com')).toBe('gmail');
    expect(detectEmailProvider('SMTP.Resend.com ')).toBe('resend');
    expect(detectEmailProvider('smtp.postmarkapp.com')).toBe('postmark');
    expect(detectEmailProvider('smtp.fastmail.com')).toBe('custom');
  });

  it('has the documented settings for each preset', () => {
    expect(getEmailProvider('gmail')).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true });
    expect(getEmailProvider('resend')).toMatchObject({ host: 'smtp.resend.com', port: 465, secure: true, fixedUser: 'resend' });
    expect(getEmailProvider('postmark')).toMatchObject({ port: 587, secure: false, tokenAsUserAndPass: true });
  });

  it('suggests the security setting for common ports', () => {
    expect(secureForPort(465)).toBe(true);
    expect(secureForPort(587)).toBe(false);
    expect(secureForPort(2525)).toBe(false);
    expect(secureForPort(8025)).toBeNull();
  });
});

describe('email log helpers', () => {
  it('finds the sign-in code', () => {
    expect(extractLoginCode('Hi John,\n\nYour code is 048213. It expires in 10 minutes.')).toBe('048213');
    expect(extractLoginCode('No code here, just 12345 or 1234567.')).toBeNull();
  });

  it('lists distinct links without trailing punctuation', () => {
    const text = 'Confirm: http://localhost:5160/portal/confirm/abc_DEF-1.\nAgain http://localhost:5160/portal/confirm/abc_DEF-1 and https://x.test/a?b=1).';
    expect(extractLinks(text)).toEqual(['http://localhost:5160/portal/confirm/abc_DEF-1', 'https://x.test/a?b=1']);
  });

  it('makes links in the preview open in a new tab', () => {
    expect(previewDocument('<html><head><title>x</title></head><body>hi</body></html>')).toContain(
      '<head><base target="_blank"><title>',
    );
    expect(previewDocument('<p>hi</p>')).toMatch(/^<!doctype html><html><head><base target="_blank">.*<body><p>hi<\/p><\/body>/);
  });
});
