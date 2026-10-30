import { describe, expect, it } from 'vitest';
import {
  comedianCsvTemplate,
  csvField,
  decodeCsvBytes,
  mapComedianColumns,
  normalizeHeader,
  parseComedianCsv,
  parseCsv,
  sniffBinarySpreadsheet,
  sniffDelimiter,
  toCsv,
} from './csv';

const cells = (text: string) => parseCsv(text).records.map((r) => r.cells);

// ---------------------------------------------------------------------------
// RFC 4180
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
  it('splits simple fields and records', () => {
    expect(cells('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with commas, escaped quotes and line breaks', () => {
    const text = 'name,note\r\n"Park, Jason","He said ""hi""\r\nthen left"\r\n"",x\r\n';
    expect(parseCsv(text).records).toEqual([
      { line: 1, cells: ['name', 'note'] },
      { line: 2, cells: ['Park, Jason', 'He said "hi"\nthen left'] },
      { line: 4, cells: ['', 'x'] },
    ]);
  });

  it('accepts CRLF, LF and old-Mac CR line endings, and a missing final newline', () => {
    expect(cells('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(cells('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(cells('a,b\rc,d\r')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('drops a UTF-8 BOM, blank lines and rows of empty cells (with their line numbers kept)', () => {
    const { records } = parseCsv('﻿Name,Email\n\n,\nJo,jo@x.test\n,,,\r\n\r\n   \n');
    expect(records).toEqual([
      { line: 1, cells: ['Name', 'Email'] },
      { line: 4, cells: ['Jo', 'jo@x.test'] },
    ]);
  });

  it('keeps empty fields, including trailing ones', () => {
    expect(cells('a,,c,\n')).toEqual([['a', '', 'c', '']]);
  });

  it('is forgiving: stray quotes are text, space before an opening quote is dropped', () => {
    expect(cells('Jason "JP" Park,jp@x.test')).toEqual([['Jason "JP" Park', 'jp@x.test']]);
    expect(cells('"Jason Park", "jp@x.test"')).toEqual([['Jason Park', 'jp@x.test']]);
    expect(cells('"Jason" Park,x')).toEqual([['Jason Park', 'x']]);
  });

  it('reports a quote that never closes (the rest becomes one field)', () => {
    const result = parseCsv('a,b\n"open,c\nd,e\n');
    expect(result.unclosedQuoteLine).toBe(2);
    expect(result.records).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['open,c\nd,e\n'] },
    ]);
    expect(parseCsv('a,"b"\n').unclosedQuoteLine).toBeNull();
  });

  it('honors an explicit delimiter and Excel\'s "sep=" line', () => {
    expect(cells('a;b,c\n')).toEqual([['a;b', 'c']]); // a tie goes to comma
    expect(parseCsv('a;b,c\n', { delimiter: ';' }).records[0]!.cells).toEqual(['a', 'b,c']);
    const sep = parseCsv('sep=;\r\nName;Email\r\nJo;jo@x.test\r\n');
    expect(sep.delimiter).toBe(';');
    expect(sep.records).toEqual([
      { line: 2, cells: ['Name', 'Email'] },
      { line: 3, cells: ['Jo', 'jo@x.test'] },
    ]);
  });

  it('stops after maxRecords', () => {
    expect(parseCsv('a\nb\nc\n', { delimiter: ',', maxRecords: 2 }).records.map((r) => r.cells[0])).toEqual(['a', 'b']);
  });
});

describe('sniffDelimiter', () => {
  it('picks comma, semicolon or tab by the most consistent split', () => {
    expect(sniffDelimiter('Name,Email\nJo,jo@x.test\n')).toBe(',');
    expect(sniffDelimiter('Name;Email;Notes\nJo;jo@x.test;Funny, dry\nAl;al@x.test;Loud\n')).toBe(';');
    expect(sniffDelimiter('Name\tEmail\tNotes\nJo\tjo@x.test\tLikes; dislikes, etc\n')).toBe('\t');
  });

  it('ignores delimiters inside quotes', () => {
    expect(sniffDelimiter('"a;b;c";d\n"e;f;g";h\n')).toBe(';');
    expect(sniffDelimiter('"Park; Jason",jp@x.test\n"Lee; Al",al@x.test\n')).toBe(',');
  });

  it('falls back to comma for a single column', () => {
    expect(sniffDelimiter('jo@x.test\nal@x.test\n')).toBe(',');
    expect(sniffDelimiter('')).toBe(',');
  });
});

describe('decodeCsvBytes', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const utf8 = (s: string) => new TextEncoder().encode(s);

  it('reads UTF-8 with or without a BOM', () => {
    expect(decodeCsvBytes(utf8('José,é'))).toBe('José,é');
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('Name')]))).toBe('Name');
  });

  it('falls back to Windows-1252 (Excel "CSV" on Windows) when it is not UTF-8', () => {
    // "José,Zoë €5" in Windows-1252
    expect(decodeCsvBytes(bytes(0x4a, 0x6f, 0x73, 0xe9, 0x2c, 0x5a, 0x6f, 0xeb, 0x20, 0x80, 0x35))).toBe('José,Zoë €5');
  });

  it('reads UTF-16 with a BOM (Excel "Unicode text")', () => {
    expect(decodeCsvBytes(bytes(0xff, 0xfe, 0x41, 0x00, 0x09, 0x00, 0xe9, 0x00))).toBe('A\té');
    expect(decodeCsvBytes(bytes(0xfe, 0xff, 0x00, 0x41))).toBe('A');
  });

  it('recognizes spreadsheet files that are not CSV', () => {
    expect(sniffBinarySpreadsheet(bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe('xlsx');
    expect(sniffBinarySpreadsheet(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1))).toBe('xls');
    expect(sniffBinarySpreadsheet(utf8('Name,Email'))).toBeNull();
  });
});

describe('writing CSV', () => {
  it('quotes only when needed and round-trips through the parser', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(' padded ')).toBe('" padded "');
    const rows = [
      ['Name', 'Notes'],
      ['Park, Jason', 'He said "hi"\nthen left'],
      ['', ' x '],
    ];
    expect(parseCsv(toCsv(rows)).records.map((r) => r.cells)).toEqual(rows);
  });

  it('builds the template: four headers and one example that imports cleanly', () => {
    const template = comedianCsvTemplate();
    expect(template.split('\r\n')[0]).toBe('Name,Email,Phone,Notes');
    const parsed = parseComedianCsv(template);
    expect(parsed.columns).toEqual({ name: 'Name', email: 'Email', phone: 'Phone', note: 'Notes' });
    expect(parsed.rows).toEqual([
      {
        line: 2,
        name: 'Jason Park',
        email: 'jason.park@example.com',
        phone: '(212) 555-0142',
        note: 'Great closer, clean set available',
        issues: [],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Comedian columns
// ---------------------------------------------------------------------------

describe('normalizeHeader', () => {
  it('ignores case, spacing, punctuation, accents, asides and numbering', () => {
    expect(normalizeHeader('  E-mail Address ')).toBe('emailaddress');
    expect(normalizeHeader('Phone #')).toBe('phone');
    expect(normalizeHeader('Phone (optional)')).toBe('phone');
    expect(normalizeHeader('Name [required]')).toBe('name');
    expect(normalizeHeader('Téléphone')).toBe('telephone');
    expect(normalizeHeader('E-mail 1 - Value')).toBe('email');
    expect(normalizeHeader('FULL_NAME')).toBe('fullname');
  });
});

describe('mapComedianColumns', () => {
  it('matches headers loosely and in any order', () => {
    const map = mapComedianColumns([['Notes', 'Cell', 'E-mail', 'Comedian'], ['x', '1', 'a@b.test', 'A']]);
    expect(map).toMatchObject({ headerRow: 0, name: 3, email: 2, phone: 1, note: 0, ignored: [] });
    expect(map.columns).toEqual({ name: 'Comedian', email: 'E-mail', phone: 'Cell', note: 'Notes' });
  });

  it.each([
    ['name', 'Name'],
    ['full name', 'Full Name'],
    ['comedian', 'COMEDIAN'],
    ['comic', 'Comic'],
    ['performer', 'Performer '],
  ])('reads the name from a "%s" column', (_label, header) => {
    expect(mapComedianColumns([[header, 'Email']]).name).toBe(0);
  });

  it.each(['Email', 'e-mail', 'Email Address', 'EMAIL_ADDRESS', 'E-mail 1 - Value'])('reads the email from "%s"', (header) => {
    expect(mapComedianColumns([['Name', header]]).email).toBe(1);
  });

  it.each(['Phone', 'Phone Number', 'Cell', 'Mobile', 'Tel', 'Telephone', 'Mobile Phone', 'Business Phone'])(
    'reads the phone from "%s"',
    (header) => {
      expect(mapComedianColumns([['Name', 'Email', header]]).phone).toBe(2);
    },
  );

  it.each(['Notes', 'note', 'Comments', 'Private notes'])('reads notes from "%s"', (header) => {
    expect(mapComedianColumns([['Name', 'Email', header]]).note).toBe(2);
  });

  it('combines first and last name columns', () => {
    const map = mapComedianColumns([['First Name', 'Last Name', 'Email']]);
    expect(map).toMatchObject({ name: null, firstName: 0, lastName: 1, email: 2 });
    expect(map.columns.name).toBe('First Name + Last Name');
  });

  it('lists the columns it ignores, and prefers the closest match when several fit', () => {
    const map = mapComedianColumns([['Name', 'Instagram', 'Home Phone', 'Mobile Phone', 'Email', 'Email', 'Agent', '']]);
    expect(map).toMatchObject({ name: 0, phone: 3, email: 4 });
    expect(map.ignored).toEqual(['Instagram', 'Home Phone', 'Email', 'Agent']);
  });

  it('reads columns in order when the first row is data', () => {
    const map = mapComedianColumns([
      ['Jason Park', 'jason@x.test', '555-0142', 'Closer', 'extra'],
      ['Comic', 'comic@x.test'],
    ]);
    expect(map).toMatchObject({ headerRow: null, name: 0, email: 1, phone: 2, note: 3, ignored: ['Column 5'] });
    expect(map.columns).toEqual({ name: 'Column 1', email: 'Column 2', phone: 'Column 3', note: 'Column 4' });
    // A header-ish word in a row that holds an email is still data.
    expect(mapComedianColumns([['Comedian', 'comedian@x.test']]).headerRow).toBeNull();
    // Columns with no data aren't reported.
    expect(mapComedianColumns([['Jo', 'jo@x.test', '', ''], ['Al', 'al@x.test']]).columns).toMatchObject({
      phone: null,
      note: null,
    });
  });

  it('finds the header under a title row', () => {
    const map = mapComedianColumns([['Comedian roster — fall 2026'], ['Name', 'Email'], ['Jo', 'jo@x.test']]);
    expect(map.headerRow).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Whole files
// ---------------------------------------------------------------------------

describe('parseComedianCsv', () => {
  it('reads the approved sketch: statuses that need no database', () => {
    const csv = [
      'Name,Email,Phone,Notes,Instagram',
      'Jason Park,jason.park@gmail.com,(212) 555-0142,"Great closer, clean set available",@jpark',
      'Keisha Grant,keisha@keishagrant.com,,,',
      'Devon Hayes,devon.hayes@yahoo.com,917-555-0199,Hosts Tuesdays at other room,',
      'Tony R,,718-555-0175,,',
      'Priya Raman,priya.r@outlook.com,+1 347 555 0103,,',
      'Jason Again,JASON.PARK@gmail.com,,,',
      ',nameless@x.test,,,',
      'Bad Phone,bad.phone@x.test,call my agent,,',
      'Bad Email,not-an-email,,,',
    ].join('\n');
    const result = parseComedianCsv(csv);
    expect(result.hasHeader).toBe(true);
    expect(result.columns).toEqual({ name: 'Name', email: 'Email', phone: 'Phone', note: 'Notes' });
    expect(result.ignored).toEqual(['Instagram']);
    expect(result.rows.map((r) => [r.line, r.name, r.issues])).toEqual([
      [2, 'Jason Park', []],
      [3, 'Keisha Grant', []],
      [4, 'Devon Hayes', []],
      [5, 'Tony R', ['invalid_email']],
      [6, 'Priya Raman', []],
      [7, 'Jason Again', ['duplicate']],
      [8, '', ['missing_name']],
      [9, 'Bad Phone', ['invalid_phone']],
      [10, 'Bad Email', ['invalid_email']],
    ]);
    expect(result.rows[0]).toEqual({
      line: 2,
      name: 'Jason Park',
      email: 'jason.park@gmail.com',
      phone: '(212) 555-0142',
      note: 'Great closer, clean set available',
      issues: [],
    });
    expect(result.rows[5]!.email).toBe('jason.park@gmail.com');
  });

  it('reads an Excel "CSV UTF-8" export (BOM, CRLF, trailing empty columns and rows)', () => {
    const csv =
      '﻿Name,Email,Phone,Notes,,\r\n' +
      'José Álvarez,jose@example.com,2125550142,"Line one\r\nLine two",,\r\n' +
      'Zoë Kim,zoe@example.com,,,,\r\n' +
      ',,,,,\r\n,,,,,\r\n';
    const result = parseComedianCsv(csv);
    expect(result.ignored).toEqual([]);
    expect(result.rows).toEqual([
      { line: 2, name: 'José Álvarez', email: 'jose@example.com', phone: '2125550142', note: 'Line one\nLine two', issues: [] },
      { line: 4, name: 'Zoë Kim', email: 'zoe@example.com', phone: '', note: '', issues: [] },
    ]);
  });

  it('reads a European Excel export (semicolons, Windows-1252 bytes)', () => {
    const text = 'Nom complet;E-mail;Mobile;Comments\r\nRenée Dubois;renee@example.fr;+33 6 12 34 56 78;Très drôle, propre\r\n';
    const latin1 = Uint8Array.from(text, (ch) => {
      const code = ch.charCodeAt(0);
      if (code > 0xff) throw new Error('not latin-1');
      return code;
    });
    const result = parseComedianCsv(decodeCsvBytes(latin1));
    expect(result.delimiter).toBe(';');
    expect(result.columns).toEqual({ name: null, email: 'E-mail', phone: 'Mobile', note: 'Comments' });
    expect(result.ignored).toEqual(['Nom complet']);
    expect(result.rows[0]).toMatchObject({ name: '', email: 'renee@example.fr', phone: '+33 6 12 34 56 78', note: 'Très drôle, propre' });
    expect(result.rows[0]!.issues).toEqual(['missing_name']);
  });

  it('reads a Google Sheets export (LF, quoted cells only where needed)', () => {
    const csv = [
      'Comic,Email Address,Cell Phone,Notes',
      'Marcus Bell,marcus@example.com,646.555.0110,',
      '"Bell, Jr., Ray",ray@example.com,(718) 555-0175 ext. 12,"Opened for ""the big name"""',
      'Lena Novak,lena@example.com,,',
    ].join('\n');
    const result = parseComedianCsv(csv);
    expect(result.rows.map(({ name, phone, note, issues }) => ({ name, phone, note, issues }))).toEqual([
      { name: 'Marcus Bell', phone: '646.555.0110', note: '', issues: [] },
      { name: 'Bell, Jr., Ray', phone: '(718) 555-0175 ext. 12', note: 'Opened for "the big name"', issues: [] },
      { name: 'Lena Novak', phone: '', note: '', issues: [] },
    ]);
  });

  it('reads a Google Contacts export (first/last name, numbered email and phone columns)', () => {
    const csv = [
      'First Name,Middle Name,Last Name,Notes,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value',
      'Omar,,Haddad,Met at the open mic,* Home,omar@example.com,Mobile,+1 917-555-0123',
    ].join('\n');
    const result = parseComedianCsv(csv);
    expect(result.columns).toEqual({
      name: 'First Name + Last Name',
      email: 'E-mail 1 - Value',
      phone: 'Phone 1 - Value',
      note: 'Notes',
    });
    expect(result.ignored).toEqual(['Middle Name', 'E-mail 1 - Label', 'Phone 1 - Label']);
    expect(result.rows[0]).toMatchObject({ name: 'Omar Haddad', email: 'omar@example.com', phone: '+1 917-555-0123', issues: [] });
  });

  it('reads a tab-separated paste copied from a spreadsheet', () => {
    const result = parseComedianCsv('Name\tEmail\tPhone\nJo Lee\tjo@x.test\t555 0100\nAl Roe\tal@x.test\t\n');
    expect(result.delimiter).toBe('\t');
    expect(result.rows.map((r) => [r.name, r.email, r.phone])).toEqual([
      ['Jo Lee', 'jo@x.test', '555 0100'],
      ['Al Roe', 'al@x.test', ''],
    ]);
  });

  it('reads a headerless file in order: Name, Email, Phone, Notes', () => {
    const result = parseComedianCsv('Jason Park,jason@x.test,555-0142,Closer\r\nKeisha Grant,keisha@x.test\r\n');
    expect(result.hasHeader).toBe(false);
    expect(result.rows.map(({ name, email, phone, note }) => ({ name, email, phone, note }))).toEqual([
      { name: 'Jason Park', email: 'jason@x.test', phone: '555-0142', note: 'Closer' },
      { name: 'Keisha Grant', email: 'keisha@x.test', phone: '', note: '' },
    ]);
  });

  it('reads pasted lists (Bulk add): Name, email / Name <email> / email, Name / tabs / "Name email"', () => {
    const text = [
      'Jason Lee, Jason@Example.com',
      '',
      '  "Maria Gomez" <maria@example.com>  ',
      'pat@example.com, Pat Smith',
      'Sam Jones\tsam@example.com',
      'Chris Rock chris@example.com',
      'no email here',
      'only@example.com',
      'Bad Email, nope@',
      'Dana Fox, 555-0100, dana@example.com, Loves late shows',
    ].join('\n');
    expect(parseComedianCsv(text).rows.map(({ line, name, email, phone, note }) => ({ line, name, email, phone, note }))).toEqual([
      { line: 1, name: 'Jason Lee', email: 'jason@example.com', phone: '', note: '' },
      { line: 3, name: 'Maria Gomez', email: 'maria@example.com', phone: '', note: '' },
      { line: 4, name: 'Pat Smith', email: 'pat@example.com', phone: '', note: '' },
      { line: 5, name: 'Sam Jones', email: 'sam@example.com', phone: '', note: '' },
      { line: 6, name: 'Chris Rock', email: 'chris@example.com', phone: '', note: '' },
      { line: 7, name: 'no email here', email: '', phone: '', note: '' },
      { line: 8, name: '', email: 'only@example.com', phone: '', note: '' },
      { line: 9, name: 'Bad Email', email: 'nope@', phone: '', note: '' },
      { line: 10, name: 'Dana Fox', email: 'dana@example.com', phone: '555-0100', note: 'Loves late shows' },
    ]);
  });

  it('cleans emails (case, mailto:, angle brackets) and names (quotes, spacing)', () => {
    const result = parseComedianCsv('Name,Email\n“Jo   Lee” ,MAILTO:Jo@X.test\nAl,Al Roe <AL@x.test>\n,Ray Day <ray@x.test>\n');
    expect(result.rows.map((r) => [r.name, r.email])).toEqual([
      ['Jo Lee', 'jo@x.test'],
      ['Al', 'al@x.test'],
      ['Ray Day', 'ray@x.test'],
    ]);
  });

  it('flags every per-row problem (limits included), most important first', () => {
    const long = 'x'.repeat(2001);
    const csv = toCsv([
      ['Name', 'Email', 'Phone', 'Notes'],
      ['A'.repeat(101), 'a@x.test', '', ''],
      ['Note Long', 'n@x.test', 'nope', long],
      ['Phone Long', 'p@x.test', '1'.repeat(41), ''],
      ['Ext Ok', 'e@x.test', '212-555-0142 x12', 'x'.repeat(2000)],
      ['', '', '', ''],
      ['   ', 'blank-name@x.test', '', ''],
    ]);
    expect(parseComedianCsv(csv).rows.map((r) => r.issues)).toEqual([
      ['name_too_long'],
      ['invalid_phone', 'note_too_long'],
      ['invalid_phone'],
      [],
      ['missing_name'],
    ]);
  });

  it('reports what it could not find', () => {
    const result = parseComedianCsv('Comedian,Contact,Agent\nJo,call me,Big Agency\n');
    expect(result.columns).toEqual({ name: 'Comedian', email: null, phone: null, note: null });
    expect(result.ignored).toEqual(['Contact', 'Agent']);
    expect(result.rows[0]!.issues).toEqual(['invalid_email']);
  });

  it('handles empty input and header-only files', () => {
    expect(parseComedianCsv('').rows).toEqual([]);
    expect(parseComedianCsv('﻿\r\n\r\n').rows).toEqual([]);
    const headerOnly = parseComedianCsv('Name,Email,Phone,Notes\r\n');
    expect(headerOnly.hasHeader).toBe(true);
    expect(headerOnly.rows).toEqual([]);
  });

  it('parses a 1,000-row file quickly', () => {
    const rows = [['Name', 'Email', 'Phone', 'Notes']];
    for (let i = 0; i < 1000; i++) rows.push([`Comic ${i}`, `comic${i}@x.test`, '(212) 555-0100', `Note, "${i}"\nline 2`]);
    const started = performance.now();
    const result = parseComedianCsv(toCsv(rows));
    expect(result.rows).toHaveLength(1000);
    expect(result.rows.every((r) => r.issues.length === 0)).toBe(true);
    expect(result.rows[999]!.line).toBe(2 + 999 * 2);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
