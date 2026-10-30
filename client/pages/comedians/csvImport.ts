/**
 * Comedians → Import CSV, the parts without React (unit-tested in csvImport.test.ts):
 * checking and reading the file, the per-row status (local checks first, then the server's
 * dry run adds "Already on roster"), and the summary toast.
 */
import {
  BULK_ADD_BODY_MAX_BYTES,
  BULK_ADD_MAX,
  BULK_RAW_MAX,
  BULK_SKIP_HINTS,
  CSV_IMPORT_MAX_BYTES,
  bulkSkipLabel,
  type BulkAddResult,
  type BulkLoginLinkResult,
  type BulkRow,
  type BulkSkip,
  type BulkSkipReason,
} from '../../../shared/api/comedians';
import { decodeCsvBytes, parseComedianCsv, sniffBinarySpreadsheet, type ComedianCsvResult, type ComedianCsvRow } from '../../../shared/csv';
import { bulkLinksToast, type LinkToast } from './loginLinks';

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "830 KB", "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

const SPREADSHEET_EXTENSIONS = /\.(xlsx|xlsm|xls|numbers|ods)$/i;
const EXPORT_HELP =
  'Save it as a CSV first: in Excel, File → Save As → "CSV UTF-8"; in Google Sheets, File → Download → "Comma-separated values"; in Numbers, File → Export To → CSV.';

/** Checked before reading the file at all. */
export function fileSizeError(name: string, size: number): string | null {
  if (size <= CSV_IMPORT_MAX_BYTES) return null;
  return `${name} is ${formatBytes(size)}. Files can be up to ${formatBytes(CSV_IMPORT_MAX_BYTES)}, so split it into smaller files and import them one at a time.`;
}

/** A bulk row as sent: raw values clamped to the hard caps, so an overlong value is reported per row. */
export function toBulkRow(row: ComedianCsvRow): BulkRow {
  return {
    name: row.name.slice(0, BULK_RAW_MAX.name),
    email: row.email.slice(0, BULK_RAW_MAX.email),
    phone: row.phone.slice(0, BULK_RAW_MAX.phone),
    note: row.note.slice(0, BULK_RAW_MAX.note),
  };
}

export type ReadRosterResult = { ok: true; parsed: ComedianCsvResult; rows: BulkRow[] } | { ok: false; error: string };

/** Check, decode and parse a chosen or dropped file; errors are ready to show. */
export function readRosterFile(name: string, bytes: Uint8Array): ReadRosterResult {
  const sizeError = fileSizeError(name, bytes.length);
  if (sizeError) return { ok: false, error: sizeError };
  if (sniffBinarySpreadsheet(bytes) || SPREADSHEET_EXTENSIONS.test(name)) {
    return { ok: false, error: `${name} is a spreadsheet file, not a CSV. ${EXPORT_HELP}` };
  }
  const text = decodeCsvBytes(bytes);
  if (text.includes('\u0000')) {
    return { ok: false, error: `${name} doesn't look like a CSV file. ${EXPORT_HELP}` };
  }
  const parsed = parseComedianCsv(text);
  if (parsed.rows.length === 0) {
    return {
      ok: false,
      error: parsed.hasHeader
        ? `${name} has a header row but no comedians under it.`
        : `${name} is empty. Add one comedian per row: Name, Email, Phone, Notes.`,
    };
  }
  if (parsed.rows.length > BULK_ADD_MAX) {
    return {
      ok: false,
      error: `${name} has ${formatCount(parsed.rows.length)} rows. Import at most ${formatCount(BULK_ADD_MAX)} at a time: split the file and import each part.`,
    };
  }
  const rows = parsed.rows.map(toBulkRow);
  const bodyBytes = new TextEncoder().encode(JSON.stringify({ rows, sendLoginLinks: true })).length;
  if (bodyBytes > BULK_ADD_BODY_MAX_BYTES) {
    return { ok: false, error: `${name} is too large to import at once. Split it into smaller files and import them one at a time.` };
  }
  return { ok: true, parsed, rows };
}

export type RowTone = 'new' | 'muted' | 'danger' | 'checking';

export interface RowStatus {
  tone: RowTone;
  /** "New", "Already on roster", "Needs an email", … */
  label: string;
  /** Why it's skipped (tooltip). */
  hint?: string;
  reason?: BulkSkipReason;
}

const MUTED_REASONS: ReadonlySet<BulkSkipReason> = new Set(['email_taken', 'duplicate']);

function skipStatus(reason: BulkSkipReason, email: string, existing?: BulkSkip['existing']): RowStatus {
  const label = bulkSkipLabel(reason, email, 'file');
  if (reason === 'email_taken' && existing) {
    return {
      tone: 'muted',
      reason,
      label: existing.archived ? `${label} (archived)` : label,
      hint: `${existing.name}${existing.archived ? ' (archived)' : ''} already uses this email. They're left as they are.`,
    };
  }
  return { tone: MUTED_REASONS.has(reason) ? 'muted' : 'danger', reason, label, hint: BULK_SKIP_HINTS[reason] };
}

/**
 * Each row's status: the server's dry run when it's in, else the local checks (rows without
 * local problems show as "checking" until the roster has been checked).
 */
export function rowStatuses(rows: readonly ComedianCsvRow[], dryRun: BulkAddResult | undefined): RowStatus[] {
  if (dryRun) {
    const skips = new Map(dryRun.skipped.map((s) => [s.index, s]));
    return rows.map((row, i) => {
      const skip = skips.get(i);
      return skip ? skipStatus(skip.reason, row.email, skip.existing) : { tone: 'new', label: 'New' };
    });
  }
  return rows.map((row) => {
    const reason = row.issues[0];
    return reason ? skipStatus(reason, row.email) : { tone: 'checking', label: 'Checking…' };
  });
}

/** The toast after importing. */
export function importToast(result: BulkAddResult, isAdmin: boolean): LinkToast {
  const added = result.created.length;
  const skipped = result.skipped.length;
  if (added === 0) {
    return { tone: 'info', title: 'Nobody imported', description: `All ${plural(skipped, 'row')} were skipped.` };
  }
  const lead = `Imported ${plural(added, 'comedian')}${skipped ? ` · skipped ${formatCount(skipped)}` : ''}`;
  const links: BulkLoginLinkResult | null = result.loginLinks;
  return links ? bulkLinksToast(lead, links, isAdmin) : { tone: 'success', title: lead };
}
