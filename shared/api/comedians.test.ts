import { describe, expect, it } from 'vitest';
import {
  bulkRowIssues,
  bulkSkipLabel,
  checkBulkRows,
  createComedianSchema,
  firstBulkReason,
  isValidPhone,
  normalizeBulkRow,
  phoneSchema,
  telHref,
  updateComedianSchema,
} from './comedians';

describe('phone numbers', () => {
  it.each([
    '',
    '(212) 555-0142',
    '917-555-0199',
    '+1 347 555 0103',
    '646.555.0110',
    '212-555-0142 x12',
    '212-555-0142 ext. 12',
    '+44 20 7946 0958',
    '2125550142',
  ])('accepts %j', (phone) => {
    expect(isValidPhone(phone)).toBe(true);
  });

  it.each(['call my agent', '555-CALL-NOW', '212/555/0142', '#212', '---', 'ext', '1'.repeat(41)])('rejects %j', (phone) => {
    expect(isValidPhone(phone)).toBe(false);
  });

  it('trims and collapses whitespace (tabs, non-breaking spaces)', () => {
    expect(phoneSchema.parse('  (212) 555-0142\t ')).toBe('(212) 555-0142');
    expect(phoneSchema.parse('   ')).toBe('');
    expect(phoneSchema.safeParse('x'.repeat(41)).success).toBe(false);
    expect(phoneSchema.safeParse('nope').error?.issues[0]?.message).toMatch(/digits/);
  });

  it('is optional when adding and editing a comedian', () => {
    expect(createComedianSchema.parse({ name: 'Jo', email: 'jo@x.test' }).phone).toBeUndefined();
    expect(createComedianSchema.parse({ name: 'Jo', email: 'jo@x.test', phone: ' 555 0100 ' }).phone).toBe('555 0100');
    expect(createComedianSchema.safeParse({ name: 'Jo', email: 'jo@x.test', phone: 'call me' }).success).toBe(false);
    expect(updateComedianSchema.parse({ phone: '' })).toEqual({ phone: '' });
  });

  it('builds tap-to-call links', () => {
    expect(telHref('(212) 555-0142')).toBe('tel:2125550142');
    expect(telHref('+1 347 555 0103')).toBe('tel:+13475550103');
    expect(telHref('212-555-0142 x12')).toBe('tel:2125550142,12');
    expect(telHref('212.555.0142 ext. 7')).toBe('tel:2125550142,7');
    expect(telHref('')).toBeNull();
  });
});

describe('bulk row checks', () => {
  it('normalizes a row the way it will be stored', () => {
    expect(
      normalizeBulkRow({ name: '  Jo   Lee ', email: ' JO@X.test ', phone: ' 555\t0100 ', note: '\r\n line 1\r\nline 2  ' }),
    ).toEqual({ name: 'Jo Lee', email: 'jo@x.test', phone: '555 0100', note: 'line 1\nline 2' });
    expect(normalizeBulkRow({ name: 'Jo', email: 'jo@x.test' })).toEqual({ name: 'Jo', email: 'jo@x.test', phone: '', note: '' });
  });

  it('lists every problem in priority order and finds duplicates of earlier valid rows', () => {
    expect(
      bulkRowIssues([
        { name: 'A', email: 'a@x.test' },
        { name: '', email: '' },
        { name: 'A twin', email: 'A@x.test', phone: 'nope' },
        { name: 'B', email: 'b@x.test', phone: 'nope', note: 'x'.repeat(2001) },
        { name: 'B fixed', email: 'b@x.test' },
        { name: 'x'.repeat(101), email: 'c@x.test' },
        { name: 'C', email: 'c@x.test' },
      ]),
    ).toEqual([
      [],
      ['invalid_email', 'missing_name'],
      ['duplicate', 'invalid_phone'],
      ['invalid_phone', 'note_too_long'],
      ['duplicate'],
      ['name_too_long'],
      [],
    ]);
  });

  it('checkBulkRows reports the first problem per row', () => {
    expect(
      checkBulkRows([
        { name: 'A', email: 'a@example.com' },
        { name: '', email: 'b@example.com' },
        { name: 'C', email: 'nope' },
        { name: 'A again', email: 'A@example.com' },
        { name: 'D', email: 'd@example.com', phone: '(212) 555-0142' },
      ]),
    ).toEqual([null, 'missing_name', 'invalid_email', 'duplicate', null]);
    expect(firstBulkReason(['note_too_long', 'email_taken', 'invalid_phone'])).toBe('email_taken');
    expect(firstBulkReason([])).toBeNull();
  });

  it('labels skipped rows the way the preview shows them', () => {
    expect(bulkSkipLabel('invalid_email', '')).toBe('Needs an email');
    expect(bulkSkipLabel('invalid_email', 'nope@')).toBe('Invalid email');
    expect(bulkSkipLabel('missing_name', 'a@x.test')).toBe('Needs a name');
    expect(bulkSkipLabel('duplicate', 'a@x.test')).toBe('Duplicate in list');
    expect(bulkSkipLabel('duplicate', 'a@x.test', 'file')).toBe('Duplicate in file');
    expect(bulkSkipLabel('email_taken', 'a@x.test')).toBe('Already on roster');
  });
});
