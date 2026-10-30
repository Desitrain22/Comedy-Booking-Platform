/**
 * CSV for imports: an RFC 4180 parser that copes with what spreadsheets really export, and
 * the comedian-roster reading used by Comedians → Import CSV and Bulk add (paste a list).
 * Pure and dependency-free apart from the shared row checks; parsing happens in the browser
 * and the server re-validates every row it receives.
 *
 *   decodeCsvBytes(bytes)      file bytes → text (UTF-8, UTF-16 with a BOM, else Windows-1252)
 *   parseCsv(text)             → { delimiter, records: [{ line, cells }], unclosedQuoteLine }
 *   mapComedianColumns(rows)   which column holds the name / email / phone / notes
 *   parseComedianCsv(text)     → { columns, rows: [{ line, name, email, phone, note, issues }], ignored }
 *   toCsv(rows), comedianCsvTemplate()
 *
 * Parsing rules: fields separated by the sniffed delimiter (comma, semicolon or tab; an
 * Excel `sep=;` first line wins), double-quoted fields may hold delimiters, quotes (as "")
 * and line breaks; CRLF, LF and lone CR all end a record; a UTF-8 BOM is dropped; blank
 * lines and rows of empty cells are skipped. Forgiving where spreadsheets and people are
 * sloppy: a quote inside an unquoted field is kept as text, whitespace before an opening
 * quote is ignored, and an unclosed quote swallows the rest of the text (reported).
 */
import { bulkRowIssues, normalizeNote, normalizePhone, type BulkRowIssue } from './api/comedians';

// ---------------------------------------------------------------------------
// Bytes → text
// ---------------------------------------------------------------------------

/** Spreadsheet files that aren't CSV, recognized by their first bytes. */
export type BinarySpreadsheet = 'xlsx' | 'xls';

/** `xlsx` (a zip: also .numbers / .ods), `xls` (old Office), or null for anything else. */
export function sniffBinarySpreadsheet(bytes: Uint8Array): BinarySpreadsheet | null {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'xls';
  return null;
}

/**
 * Decode a CSV file. A byte-order mark decides (UTF-8, UTF-16 LE/BE: Excel's "Unicode
 * text"); otherwise UTF-8, falling back to Windows-1252 when the bytes aren't valid UTF-8
 * (Excel's plain "CSV" on Windows). The BOM is not included in the result.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export const CSV_DELIMITERS = [',', ';', '\t'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export interface CsvRecord {
  /** 1-based line of the text where the record starts. */
  line: number;
  cells: string[];
}

export interface CsvParseResult {
  delimiter: CsvDelimiter;
  /** Non-blank records in order (a record whose cells are all blank is skipped). */
  records: CsvRecord[];
  /** Line of a quote that never closes (the rest of the text became one field), else null. */
  unclosedQuoteLine: number | null;
}

export interface ParseCsvOptions {
  /** Skip sniffing. */
  delimiter?: CsvDelimiter;
  /** Stop after this many records (used for sniffing). */
  maxRecords?: number;
}

const BOM = '﻿';
/** Excel's "sep=;" hint line. */
const SEP_LINE = /^sep=([,;\t])[ ]*(?:\r\n|\n|\r|$)/i;
/** How much of the text the delimiter sniffer looks at. */
const SNIFF_RECORDS = 50;
const SNIFF_CHARS = 64 * 1024;

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** RFC 4180 parsing; see the file comment for the forgiving parts. */
export function parseCsv(input: string, options: ParseCsvOptions = {}): CsvParseResult {
  let text = stripBom(input);
  let line = 1;
  let delimiter = options.delimiter;
  const sep = SEP_LINE.exec(text);
  if (sep) {
    delimiter ??= sep[1] as CsvDelimiter;
    text = text.slice(sep[0].length);
    line = 2;
  }
  delimiter ??= sniffDelimiter(text);
  const maxRecords = options.maxRecords ?? Infinity;

  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  // The current field opened with a quote (a later quote is plain text).
  let fieldQuoted = false;
  let recordLine = line;
  let quoteLine = 0;

  const endField = () => {
    cells.push(field);
    field = '';
    fieldQuoted = false;
  };
  const endRecord = () => {
    endField();
    if (cells.some((cell) => cell.trim() !== '')) records.push({ line: recordLine, cells });
    cells = [];
  };

  const n = text.length;
  let i = 0;
  while (i < n && records.length < maxRecords) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else if (ch === '\r' || ch === '\n') {
        // A line break inside a cell; stored as \n whatever the file uses.
        field += '\n';
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        line += 1;
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"' && !fieldQuoted && field.trim() === '') {
      // Opening quote (whitespace before it, as in `a, "b"`, is dropped).
      inQuotes = true;
      fieldQuoted = true;
      field = '';
      quoteLine = line;
      i += 1;
    } else if (ch === delimiter) {
      endField();
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (i >= n && (field !== '' || cells.length > 0 || inQuotes)) endRecord();

  return { delimiter, records, unclosedQuoteLine: inQuotes ? quoteLine : null };
}

/**
 * The delimiter that splits the first lines into the most consistent number of columns
 * (at least 2). Ties go to the wider split, then to comma › semicolon › tab. Comma when
 * nothing splits (a single column).
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const sample = stripBom(text).slice(0, SNIFF_CHARS);
  let best: { delimiter: CsvDelimiter; consistency: number; width: number } | null = null;
  for (const delimiter of CSV_DELIMITERS) {
    const { records } = parseCsv(sample, { delimiter, maxRecords: SNIFF_RECORDS });
    if (records.length === 0) continue;
    const tally = new Map<number, number>();
    for (const r of records) tally.set(r.cells.length, (tally.get(r.cells.length) ?? 0) + 1);
    let width = 0;
    let hits = 0;
    for (const [w, count] of tally) {
      if (count > hits || (count === hits && w > width)) {
        width = w;
        hits = count;
      }
    }
    if (width < 2) continue;
    const consistency = hits / records.length;
    if (!best || consistency > best.consistency || (consistency === best.consistency && width > best.width)) {
      best = { delimiter, consistency, width };
    }
  }
  return best?.delimiter ?? ',';
}

/** One CSV field, quoted when it has to be (delimiter, quote, line break, edge spaces). */
export function csvField(value: string, delimiter: CsvDelimiter = ','): string {
  const needsQuotes = value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim();
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Rows → CSV text (CRLF line endings, as RFC 4180 says). */
export function toCsv(rows: readonly (readonly string[])[], delimiter: CsvDelimiter = ','): string {
  return rows.map((row) => row.map((cell) => csvField(cell, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Comedian rosters
// ---------------------------------------------------------------------------

export type ComedianCsvField = 'name' | 'email' | 'phone' | 'note';

/** The template's headers (and the order headerless files are read in). */
export const COMEDIAN_CSV_HEADERS = ['Name', 'Email', 'Phone', 'Notes'] as const;
export const COMEDIAN_CSV_TEMPLATE_NAME = 'comedians-template.csv';

/** `comedians-template.csv`: the four headers and one example comedian. */
export function comedianCsvTemplate(): string {
  return toCsv([
    [...COMEDIAN_CSV_HEADERS],
    ['Jason Park', 'jason.park@example.com', '(212) 555-0142', 'Great closer, clean set available'],
  ]);
}

type ColumnKey = 'name' | 'firstName' | 'lastName' | 'email' | 'phone' | 'note';

/**
 * Header names per field, normalized (see `normalizeHeader`). Earlier entries win when a
 * file has several candidates for one field.
 */
const HEADER_ALIASES: Record<ColumnKey, readonly string[]> = {
  name: ['name', 'fullname', 'comedian', 'comic', 'performer', 'comedianname', 'comicname', 'performername', 'stagename', 'displayname', 'contactname'],
  firstName: ['firstname', 'first', 'givenname', 'forename', 'fname'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  email: ['email', 'emailaddress', 'mail', 'emails', 'emailaddr', 'primaryemail', 'contactemail', 'personalemail', 'workemail'],
  phone: ['phone', 'phonenumber', 'phoneno', 'cell', 'cellphone', 'cellnumber', 'mobile', 'mobilephone', 'mobilenumber', 'tel', 'telephone', 'telephonenumber', 'telno', 'primaryphone', 'contactnumber'],
  note: ['notes', 'note', 'comments', 'comment', 'remarks', 'bookernotes'],
};
/** Looser fallbacks: "Business Phone", "Home Email Address". */
const HEADER_SUFFIXES: Partial<Record<ColumnKey, readonly string[]>> = {
  email: ['email', 'emailaddress'],
  phone: ['phone', 'phonenumber'],
  note: ['notes'],
};
const KEYS: readonly ColumnKey[] = ['name', 'firstName', 'lastName', 'email', 'phone', 'note'];
/** Headers may sit under a few title rows ("Comedian roster — fall 2026"). */
const HEADER_SEARCH_ROWS = 3;

/**
 * Lowercase letters and digits only, without accents, bracketed asides ("Phone (cell)"),
 * or Google Contacts' numbering ("E-mail 1 - Value" → "email").
 */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/value$/, '')
    .replace(/\d+$/, '');
}

/** How well a header names a field: 2 exact alias (earlier = better), 1 suffix match, 0 none. */
function headerScore(header: string, key: ColumnKey): number {
  const h = normalizeHeader(header);
  if (!h) return 0;
  const exact = HEADER_ALIASES[key].indexOf(h);
  if (exact !== -1) return 2 + (HEADER_ALIASES[key].length - exact) / 100;
  if (HEADER_SUFFIXES[key]?.some((suffix) => h.endsWith(suffix))) return 1;
  return 0;
}

const EMAIL_LIKE = /[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+/;

function looksLikeEmail(cell: string | undefined): boolean {
  return cell !== undefined && EMAIL_LIKE.test(cell);
}

function isHeaderRow(cells: readonly string[]): boolean {
  if (cells.some(looksLikeEmail)) return false;
  return cells.some((cell) => KEYS.some((key) => headerScore(cell, key) > 0));
}

export interface ComedianColumnMap {
  /** Index of the header row in `rows`, or null when columns are read in order (Name, Email, Phone, Notes). */
  headerRow: number | null;
  /** Column indexes (null = not in the file). Without a header: 0, 1, 2, 3. */
  name: number | null;
  /** First + last name columns, combined when there's no full-name column (or it's blank). */
  firstName: number | null;
  lastName: number | null;
  email: number | null;
  phone: number | null;
  note: number | null;
  /**
   * Where each field is read from, for display: the header text ("E-mail Address"),
   * "First Name + Last Name", or "Column 2" without a header. Null = not in the file.
   */
  columns: Record<ComedianCsvField, string | null>;
  /** Columns that aren't used: their header, or "Column 5" (only if it has data). */
  ignored: string[];
}

/**
 * Work out which column holds what. The header is the first row (or one of the first few,
 * under title rows) that names at least one known field and holds no email address;
 * headers match loosely (case, spacing and punctuation don't matter). Without one, columns
 * are read in order: Name, Email, Phone, Notes.
 */
export function mapComedianColumns(rows: readonly (readonly string[])[]): ComedianColumnMap {
  let headerRow: number | null = null;
  for (let r = 0; r < Math.min(rows.length, HEADER_SEARCH_ROWS); r++) {
    const cells = rows[r]!;
    if (cells.some(looksLikeEmail)) break;
    if (isHeaderRow(cells)) {
      headerRow = r;
      break;
    }
  }

  if (headerRow === null) {
    const width = Math.max(0, ...rows.map((r) => r.length));
    const ignored: string[] = [];
    for (let col = COMEDIAN_CSV_HEADERS.length; col < width; col++) {
      if (rows.some((r) => (r[col] ?? '').trim() !== '')) ignored.push(`Column ${col + 1}`);
    }
    const hasData = (col: number) => rows.some((r) => (r[col] ?? '').trim() !== '');
    return {
      headerRow: null,
      name: 0,
      firstName: null,
      lastName: null,
      email: 1,
      phone: 2,
      note: 3,
      columns: {
        name: 'Column 1',
        email: 'Column 2',
        phone: hasData(2) ? 'Column 3' : null,
        note: hasData(3) ? 'Column 4' : null,
      },
      ignored,
    };
  }

  const header = rows[headerRow]!;
  const found: Record<ColumnKey, number | null> = {
    name: null,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    note: null,
  };
  const used = new Set<number>();
  for (const key of KEYS) {
    let bestCol = -1;
    let bestScore = 0;
    for (let col = 0; col < header.length; col++) {
      const score = used.has(col) ? 0 : headerScore(header[col]!, key);
      if (score > bestScore) {
        bestScore = score;
        bestCol = col;
      }
    }
    if (bestCol !== -1) {
      found[key] = bestCol;
      used.add(bestCol);
    }
  }

  const label = (col: number | null) => (col === null ? null : header[col]!.trim());
  const nameParts = [found.firstName, found.lastName].filter((col): col is number => col !== null);
  return {
    headerRow,
    ...found,
    columns: {
      name: label(found.name) ?? (nameParts.length ? nameParts.map((col) => header[col]!.trim()).join(' + ') : null),
      email: label(found.email),
      phone: label(found.phone),
      note: label(found.note),
    },
    ignored: header.flatMap((cell, col) => (!used.has(col) && cell.trim() !== '' ? [cell.trim()] : [])),
  };
}

export interface ComedianCsvRow {
  /** Line in the file where the row starts (1-based). */
  line: number;
  name: string;
  /** Lowercased; '' when missing. */
  email: string;
  phone: string;
  note: string;
  /** Problems found without the database (`bulkRowIssues`), most important first; [] = looks fine. */
  issues: BulkRowIssue[];
}

export interface ComedianCsvResult {
  columns: ComedianColumnMap['columns'];
  /** The file had a header row (else columns were read in order). */
  hasHeader: boolean;
  rows: ComedianCsvRow[];
  /** Columns that weren't imported. */
  ignored: string[];
  delimiter: CsvDelimiter;
  /** A quote that never closes, so the rest of the file became one cell (show a warning). */
  unclosedQuoteLine: number | null;
}

function cleanName(value: string): string {
  return value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanEmail(value: string): string {
  return value
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^[<("'“‘]+|[>)"'”’,;.]+$/g, '')
    .trim()
    .toLowerCase();
}

/** A cell holding an email and maybe a name: `Jason Lee <jason@x.com>`, `Jason Lee jason@x.com`. */
function splitNameEmail(cell: string): { name: string; email: string } {
  const angle = /^(.*?)<([^<>]*)>(.*)$/.exec(cell);
  if (angle && angle[2]!.includes('@')) {
    return { name: cleanName(`${angle[1]!} ${angle[3]!}`.replace(/[,;]/g, ' ')), email: cleanEmail(angle[2]!) };
  }
  const tokens = cell.trim().split(/\s+/);
  const at = tokens.findIndex((t) => t.includes('@'));
  if (at === -1) return { name: '', email: cleanEmail(cell) };
  return { name: cleanName(tokens.filter((_, i) => i !== at).join(' ')), email: cleanEmail(tokens[at]!) };
}

/**
 * A headerless row: Name, Email, Phone, Notes in order. Pasted lists are looser, so when the
 * second cell isn't an email but another one is, that one is the email and the rest fill
 * Name, Phone, Notes in order (`email, Name`; `Name <email>`; `Name email`).
 */
function readPositional(cells: readonly string[]): Omit<ComedianCsvRow, 'line' | 'issues'> {
  const emailCol = looksLikeEmail(cells[1]) ? 1 : cells.findIndex((cell) => looksLikeEmail(cell));
  if (emailCol === -1) {
    return {
      name: cleanName(cells[0] ?? ''),
      email: cleanEmail(cells[1] ?? ''),
      phone: normalizePhone(cells[2] ?? ''),
      note: normalizeNote(cells[3] ?? ''),
    };
  }
  const split = splitNameEmail(cells[emailCol]!);
  const rest = cells.filter((_, col) => col !== emailCol);
  return {
    name: cleanName(rest[0] ?? '') || split.name,
    email: split.email,
    phone: normalizePhone(rest[1] ?? ''),
    note: normalizeNote(rest[2] ?? ''),
  };
}

function readMapped(cells: readonly string[], map: ComedianColumnMap): Omit<ComedianCsvRow, 'line' | 'issues'> {
  const cell = (col: number | null) => (col === null ? '' : (cells[col] ?? ''));
  const split = map.email === null ? { name: '', email: '' } : splitNameEmail(cell(map.email));
  const full = cleanName(cell(map.name));
  const parts = cleanName(`${cell(map.firstName)} ${cell(map.lastName)}`);
  return {
    name: full || parts || split.name,
    email: split.email,
    phone: normalizePhone(cell(map.phone)),
    note: normalizeNote(cell(map.note)),
  };
}

/**
 * Read a roster: CSV text (a file, or a list pasted into Bulk add) → one row per comedian
 * with the problems each has on its own. The server adds "already on roster".
 */
export function parseComedianCsv(text: string): ComedianCsvResult {
  const parsed = parseCsv(text);
  const cells = parsed.records.map((r) => r.cells);
  const map = mapComedianColumns(cells);
  const start = map.headerRow === null ? 0 : map.headerRow + 1;
  const records = parsed.records.slice(start);
  const fields = records.map((r) => (map.headerRow === null ? readPositional(r.cells) : readMapped(r.cells, map)));
  const issues = bulkRowIssues(fields);
  return {
    columns: map.columns,
    hasHeader: map.headerRow !== null,
    rows: fields.map((f, i) => ({ line: records[i]!.line, ...f, issues: issues[i]! })),
    ignored: map.ignored,
    delimiter: parsed.delimiter,
    unclosedQuoteLine: parsed.unclosedQuoteLine,
  };
}
