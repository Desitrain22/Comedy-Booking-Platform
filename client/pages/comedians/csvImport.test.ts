import { describe, expect, it } from 'vitest';
import { CSV_IMPORT_MAX_BYTES, type BulkAddResult } from '../../../shared/api/comedians';
import { parseComedianCsv } from '../../../shared/csv';
import { fileSizeError, formatBytes, importToast, readRosterFile, rowStatuses, toBulkRow } from './csvImport';
import { outboxHint } from './loginLinks';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('reading the file', () => {
  it('formats sizes', () => {
    expect(formatBytes(200)).toBe('1 KB');
    expect(formatBytes(830 * 1024)).toBe('830 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatBytes(2.44 * 1024 * 1024)).toBe('2.4 MB');
  });

  it('refuses files over 2 MB before reading them', () => {
    expect(fileSizeError('roster.csv', CSV_IMPORT_MAX_BYTES)).toBeNull();
    expect(fileSizeError('roster.csv', CSV_IMPORT_MAX_BYTES + 1)).toBe(
      'roster.csv is 2 MB. Files can be up to 2 MB, so split it into smaller files and import them one at a time.',
    );
    expect(fileSizeError('big.csv', 3.5 * 1024 * 1024)).toMatch(/^big\.csv is 3\.5 MB\./);
  });

  it('explains spreadsheet files and other non-CSV files', () => {
    const xlsx = readRosterFile('Roster.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    expect(xlsx).toEqual({ ok: false, error: expect.stringMatching(/^Roster\.xlsx is a spreadsheet file, not a CSV\. Save it as a CSV first/) });
    expect(readRosterFile('roster.numbers', utf8('whatever')).ok).toBe(false);
    expect(readRosterFile('photo.csv', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))).toEqual({
      ok: false,
      error: expect.stringMatching(/doesn't look like a CSV file/),
    });
  });

  it('explains empty files and header-only files', () => {
    expect(readRosterFile('empty.csv', utf8('\r\n'))).toEqual({ ok: false, error: expect.stringMatching(/^empty\.csv is empty\./) });
    expect(readRosterFile('header.csv', utf8('Name,Email\r\n'))).toEqual({
      ok: false,
      error: 'header.csv has a header row but no comedians under it.',
    });
  });

  it('refuses more than 1,000 rows', () => {
    const lines = ['Name,Email', ...Array.from({ length: 1001 }, (_, i) => `C${i},c${i}@x.test`)];
    expect(readRosterFile('big.csv', utf8(lines.join('\n')))).toEqual({
      ok: false,
      error: 'big.csv has 1,001 rows. Import at most 1,000 at a time: split the file and import each part.',
    });
    expect(readRosterFile('ok.csv', utf8(lines.slice(0, 1001).join('\n'))).ok).toBe(true);
  });

  it('parses a good file into rows ready to send (clamped to the hard caps)', () => {
    const result = readRosterFile('roster.csv', utf8(`Name,Email,Notes\nJo,jo@x.test,${'n'.repeat(9000)}\n`));
    if (!result.ok) throw new Error(result.error);
    expect(result.parsed.rows[0]!.note).toHaveLength(9000);
    expect(result.rows[0]!.note).toHaveLength(8000);
    expect(result.parsed.rows[0]!.issues).toEqual(['note_too_long']);
    expect(toBulkRow(result.parsed.rows[0]!)).toEqual(result.rows[0]);
  });
});

describe('row statuses', () => {
  const parsed = parseComedianCsv(
    ['Name,Email,Phone', 'Jo,jo@x.test,', 'Al,,', 'Maria,maria@x.test,', 'Jo again,jo@x.test,', 'Bad,b@x.test,call me'].join('\n'),
  );

  it('uses the local checks until the roster has been checked', () => {
    expect(rowStatuses(parsed.rows, undefined).map((s) => [s.tone, s.label])).toEqual([
      ['checking', 'Checking…'],
      ['danger', 'Needs an email'],
      ['checking', 'Checking…'],
      ['muted', 'Duplicate in file'],
      ['danger', 'Invalid phone'],
    ]);
  });

  it('then uses the dry run, which adds "Already on roster"', () => {
    const dryRun: BulkAddResult = {
      dryRun: true,
      created: [{ index: 0, id: 0, name: 'Jo', email: 'jo@x.test', phone: '', note: '' }],
      skipped: [
        { index: 1, row: { name: 'Al', email: '' }, reason: 'invalid_email' },
        { index: 2, row: { name: 'Maria', email: 'maria@x.test' }, reason: 'email_taken', existing: { id: 9, name: 'Maria Delgado', archived: true } },
        { index: 3, row: { name: 'Jo again', email: 'jo@x.test' }, reason: 'duplicate' },
        { index: 4, row: { name: 'Bad', email: 'b@x.test', phone: 'call me' }, reason: 'invalid_phone' },
      ],
      loginLinks: null,
    };
    const statuses = rowStatuses(parsed.rows, dryRun);
    expect(statuses.map((s) => [s.tone, s.label])).toEqual([
      ['new', 'New'],
      ['danger', 'Needs an email'],
      ['muted', 'Already on roster (archived)'],
      ['muted', 'Duplicate in file'],
      ['danger', 'Invalid phone'],
    ]);
    expect(statuses[2]!.hint).toBe("Maria Delgado (archived) already uses this email. They're left as they are.");
    expect(statuses[4]!.hint).toMatch(/digits/);
  });
});

describe('import toast', () => {
  const created = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, id: i + 1, name: `C${i}`, email: `c${i}@x.test`, phone: '', note: '' }));
  const skipped = (n: number) => Array.from({ length: n }, (_, i) => ({ index: 100 + i, row: { name: 'x', email: '' }, reason: 'invalid_email' as const }));

  it('summarizes what was imported and skipped', () => {
    expect(importToast({ dryRun: false, created: created(3), skipped: skipped(2), loginLinks: null }, true)).toEqual({
      tone: 'success',
      title: 'Imported 3 comedians · skipped 2',
    });
    expect(importToast({ dryRun: false, created: created(1), skipped: [], loginLinks: null }, true).title).toBe('Imported 1 comedian');
    expect(importToast({ dryRun: false, created: [], skipped: skipped(4), loginLinks: null }, true)).toEqual({
      tone: 'info',
      title: 'Nobody imported',
      description: 'All 4 rows were skipped.',
    });
  });

  it('mentions the sign-in links', () => {
    const toast = importToast(
      { dryRun: false, created: created(3), skipped: skipped(1), loginLinks: { sent: 0, outbox: 3, failed: 0, skipped: 0 } },
      false,
    );
    expect(toast).toEqual({
      tone: 'success',
      title: 'Imported 3 comedians · skipped 1',
      description: `Sent 3 sign-in links. ${outboxHint(false, 3)}`,
    });
  });
});
