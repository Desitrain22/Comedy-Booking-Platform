/**
 * Comedians → Import CSV (approved sketch: .superpowers/brainstorm/…/csv-import.html).
 *
 * Choose or drop a .csv → the columns found (unknown ones listed as ignored) → a preview
 * with a status per row (the browser checks each row, then a dry run against the roster adds
 * "Already on roster") → "Email each new comedian a sign-in link" (on by default) →
 * Import N comedians → summary toast. Nothing is saved before Import; the server checks
 * every row again. Also used by step 3 of the setup guide.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Download, FileSpreadsheet, Minus, RotateCw, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { BULK_ADD_MAX, CSV_IMPORT_MAX_BYTES, type BulkAddResult, type BulkRow } from '../../../shared/api/comedians';
import {
  COMEDIAN_CSV_TEMPLATE_NAME,
  comedianCsvTemplate,
  type ComedianCsvField,
  type ComedianCsvResult,
} from '../../../shared/csv';
import { Button, Dialog, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useBooker } from '../../lib/useMe';
import { fileSizeError, formatBytes, formatCount, importToast, readRosterFile, rowStatuses, type RowStatus } from './csvImport';
import { invalidateComedians } from './queries';

export interface ImportCsvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface LoadedFile {
  /** Changes with every file read (keys the roster check). */
  id: number;
  name: string;
  parsed: ComedianCsvResult;
  rows: BulkRow[];
}

const ACCEPT = '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain';

/** Save `comedians-template.csv` (made in the browser). */
function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([comedianCsvTemplate()], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = COMEDIAN_CSV_TEMPLATE_NAME;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

export function ImportCsvDialog({ open, onOpenChange }: ImportCsvDialogProps) {
  const queryClient = useQueryClient();
  const isAdmin = useBooker().role === 'admin';
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sendLinks, setSendLinks] = useState(true);

  // A file dropped beside the drop zone must not make the browser open it (and lose the dialog).
  useEffect(() => {
    if (!open) return;
    const block = (e: globalThis.DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, [open]);

  // The roster check: a dry run reports who's already on the roster (and re-checks every row).
  const preview = useQuery({
    queryKey: ['comedians', 'import-preview', file?.id ?? 0],
    queryFn: () => api.post<BulkAddResult>('/comedians/bulk', { rows: file!.rows, dryRun: true }),
    enabled: open && file !== null,
    staleTime: 0,
    gcTime: 0,
  });
  const dryRun = preview.data;

  const statuses = useMemo(() => (file ? rowStatuses(file.parsed.rows, dryRun) : []), [file, dryRun]);
  const newCount = dryRun?.created.length ?? 0;
  const skipCount = dryRun?.skipped.length ?? 0;

  const importRows = useMutation({
    mutationFn: (input: { rows: BulkRow[]; sendLoginLinks: boolean }) => api.post<BulkAddResult>('/comedians/bulk', input),
    meta: { silent: true }, // shown in the dialog
    onSuccess: (result) => {
      invalidateComedians(queryClient);
      const t = importToast(result, isAdmin);
      toast[t.tone](t.title, { description: t.description });
      close(false);
    },
  });

  function close(next: boolean) {
    if (!next) {
      setFile(null);
      setError(null);
      setDragging(false);
      setSendLinks(true);
      importRows.reset();
    }
    onOpenChange(next);
  }

  async function load(chosen: File) {
    importRows.reset();
    const sizeError = fileSizeError(chosen.name, chosen.size);
    if (sizeError) {
      setFile(null);
      setError(sizeError);
      return;
    }
    setReading(true);
    try {
      const result = readRosterFile(chosen.name, new Uint8Array(await chosen.arrayBuffer()));
      if (result.ok) {
        setFile({ id: nextId.current++, name: chosen.name, parsed: result.parsed, rows: result.rows });
        setError(null);
      } else {
        setFile(null);
        setError(result.error);
      }
    } catch {
      setFile(null);
      setError(`Couldn't read ${chosen.name}. Try choosing it again.`);
    } finally {
      setReading(false);
    }
  }

  function chooseFile() {
    if (inputRef.current) {
      inputRef.current.value = ''; // choosing the same file again still fires onChange
      inputRef.current.click();
    }
  }

  const dropHandlers = {
    onDragEnter: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const files = e.dataTransfer.files;
      if (files.length > 1) setError('Drop one file at a time.');
      else if (files[0]) void load(files[0]);
    },
  };

  const checking = file !== null && preview.isPending;
  const canImport = file !== null && dryRun !== undefined && newCount > 0 && !preview.isFetching;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Import comedians from a CSV"
      description="Bring in your roster from a spreadsheet. You'll see every row before anything is saved."
      size="xl"
      footer={
        file ? (
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
            <label className="flex items-center gap-2 text-sm text-fg sm:mr-auto">
              <input
                type="checkbox"
                checked={sendLinks}
                onChange={(e) => setSendLinks(e.target.checked)}
                className="size-4 shrink-0 rounded accent-accent-solid"
              />
              Email each new comedian a sign-in link
            </label>
            <p className="text-sm text-fg-muted" aria-live="polite">
              {checking ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner className="size-3.5" /> Checking your roster…
                </span>
              ) : dryRun ? (
                newCount > 0 ? (
                  `${formatCount(newCount)} will be added${skipCount ? ` · ${formatCount(skipCount)} skipped` : ''}`
                ) : (
                  `Nothing new to add · ${formatCount(skipCount)} skipped`
                )
              ) : null}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => importRows.mutate({ rows: file.rows, sendLoginLinks: sendLinks })}
                loading={importRows.isPending}
                disabled={!canImport}
              >
                {newCount > 0 ? `Import ${formatCount(newCount)} comedian${newCount === 1 ? '' : 's'}` : 'Import comedians'}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
        )
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label="CSV file"
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) void load(chosen);
        }}
      />

      <div className="space-y-4">
        {file ? (
          <div
            {...dropHandlers}
            className={cn(
              'flex flex-col gap-2 rounded-xl border-2 border-dashed px-4 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between',
              dragging ? 'border-accent bg-accent-soft' : 'border-border-strong',
            )}
          >
            <p className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
              <FileSpreadsheet className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              <span className="truncate font-semibold text-fg">{file.name}</span>
              <span className="shrink-0">
                · {formatCount(file.parsed.rows.length)} row{file.parsed.rows.length === 1 ? '' : 's'}
              </span>
            </p>
            <p className="flex shrink-0 items-center gap-3 text-sm">
              <button type="button" onClick={downloadTemplate} className="font-medium text-accent hover:underline">
                Download a template
              </button>
              <span aria-hidden className="text-fg-subtle">
                ·
              </span>
              <button type="button" onClick={chooseFile} className="font-medium text-accent hover:underline">
                {reading ? 'Reading…' : 'Choose another file'}
              </button>
            </p>
          </div>
        ) : (
          <DropZone dragging={dragging} reading={reading} onChoose={chooseFile} {...dropHandlers} />
        )}

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-fg">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        {file && (
          <>
            <ColumnsFound parsed={file.parsed} />
            {file.parsed.unclosedQuoteLine !== null && (
              <p className="flex items-start gap-2 rounded-lg bg-awaiting-soft px-3 py-2 text-sm text-awaiting-fg">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                A quote opened on line {file.parsed.unclosedQuoteLine} never closes, so everything after it was read as one
                cell. Check that line in your spreadsheet.
              </p>
            )}
            {preview.isError && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm">
                <CircleAlert className="size-4 text-danger" aria-hidden />
                <span className="flex-1">Couldn't check your roster: {errorMessage(preview.error)}</span>
                <Button size="sm" variant="secondary" onClick={() => void preview.refetch()}>
                  <RotateCw /> Try again
                </Button>
              </div>
            )}
            {importRows.isError && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-fg">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                Nothing was imported: {errorMessage(importRows.error)}
              </p>
            )}
            <PreviewTable parsed={file.parsed} statuses={statuses} />
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

interface DropZoneProps {
  dragging: boolean;
  reading: boolean;
  onChoose: () => void;
  onDragEnter: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

function DropZone({ dragging, reading, onChoose, ...handlers }: DropZoneProps) {
  const hintId = useId();
  return (
    <div className="space-y-3">
      <div
        {...handlers}
        data-testid="csv-drop-zone"
        className={cn(
          'flex flex-col items-center rounded-xl border-2 border-dashed px-6 py-9 text-center transition-colors',
          dragging ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface-2/40',
        )}
      >
        <div
          className={cn(
            'mb-3 flex size-11 items-center justify-center rounded-full',
            dragging ? 'bg-accent text-accent-solid-fg' : 'bg-surface-3 text-fg-muted',
          )}
        >
          {reading ? <Spinner className="size-5" /> : <Upload className="size-5" aria-hidden />}
        </div>
        <p className="text-sm font-medium text-fg">{dragging ? 'Drop it to read it' : 'Drop your CSV file here'}</p>
        <p className="mt-0.5 mb-4 text-sm text-fg-muted">or</p>
        <Button onClick={onChoose} loading={reading} aria-describedby={hintId}>
          Choose a file
        </Button>
        <p id={hintId} className="mt-4 max-w-lg text-xs leading-relaxed text-fg-muted">
          One comedian per row with <b className="font-medium text-fg">Name</b> and <b className="font-medium text-fg">Email</b>{' '}
          (required), <b className="font-medium text-fg">Phone</b> and <b className="font-medium text-fg">Notes</b> (optional).
          <br className="hidden sm:inline" /> Column names don't have to match exactly. Up to{' '}
          <span className="whitespace-nowrap">
            {formatCount(BULK_ADD_MAX)} comedians ({formatBytes(CSV_IMPORT_MAX_BYTES)}).
          </span>
        </p>
      </div>
      <div className="flex flex-col gap-1 text-sm text-fg-muted sm:flex-row sm:items-center sm:justify-between">
        <p>In Excel or Google Sheets: File → Save As / Download → CSV.</p>
        <button
          type="button"
          onClick={downloadTemplate}
          className="inline-flex items-center gap-1.5 self-start font-medium text-accent hover:underline sm:self-auto"
        >
          <Download className="size-4" aria-hidden /> Download a template
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<ComedianCsvField, string> = { name: 'Name', email: 'Email', phone: 'Phone', note: 'Notes' };
const REQUIRED: ReadonlySet<ComedianCsvField> = new Set(['name', 'email']);

function ColumnsFound({ parsed }: { parsed: ComedianCsvResult }) {
  const fields: ComedianCsvField[] = ['name', 'email', 'phone', 'note'];
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="csv-columns">
        <span className="mr-1 font-medium text-fg-muted">Columns found:</span>
        {fields.map((field) => {
          const source = parsed.columns[field];
          const missingRequired = !source && REQUIRED.has(field);
          const renamed = source && source.toLowerCase() !== FIELD_LABELS[field].toLowerCase();
          return (
            <span
              key={field}
              title={source ? `From the “${source}” column` : `No ${FIELD_LABELS[field].toLowerCase()} column found`}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium',
                source
                  ? 'border-confirmed/50 text-confirmed-fg'
                  : missingRequired
                    ? 'border-danger/40 bg-danger-soft text-danger'
                    : 'border-border-strong text-fg-subtle',
              )}
            >
              <span>{FIELD_LABELS[field]}</span>
              {source ? <Check className="size-3" aria-label="found" /> : <Minus className="size-3" aria-label="not found" />}
              {renamed && <span className="max-w-32 truncate font-normal text-fg-muted">({source})</span>}
            </span>
          );
        })}
        {parsed.ignored.length > 0 && (
          <span className="ml-1 text-fg-muted">
            Ignored: <span className="text-fg">{parsed.ignored.join(', ')}</span>
          </span>
        )}
      </div>
      {!parsed.hasHeader && (
        <p className="text-xs text-fg-muted">No header row, so columns are read in order: Name, Email, Phone, Notes.</p>
      )}
      {(!parsed.columns.name || !parsed.columns.email) && parsed.hasHeader && (
        <p className="text-xs text-danger">
          Every comedian needs a name and an email. Add {!parsed.columns.name && !parsed.columns.email ? 'Name and Email columns' : !parsed.columns.name ? 'a Name column' : 'an Email column'}{' '}
          (or rename the column that has them), then choose the file again.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const TONE_CLASSES: Record<RowStatus['tone'], string> = {
  new: 'bg-confirmed-soft text-confirmed-fg',
  muted: 'bg-surface-2 text-fg-muted',
  danger: 'bg-unconfirmed-soft text-unconfirmed-fg',
  checking: 'bg-surface-2 text-fg-subtle',
};

function StatusPill({ status }: { status: RowStatus }) {
  return (
    <span
      title={status.hint}
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap', TONE_CLASSES[status.tone])}
    >
      {status.label}
    </span>
  );
}

function PreviewTable({ parsed, statuses }: { parsed: ComedianCsvResult; statuses: RowStatus[] }) {
  return (
    <div className="max-h-[min(26rem,45dvh)] overflow-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm" data-testid="csv-preview">
        <thead className="sticky top-0 z-[1] bg-surface-2 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          <tr>
            <th scope="col" className="hidden w-12 px-3 py-2 sm:table-cell">
              Line
            </th>
            <th scope="col" className="px-3 py-2">
              Name
            </th>
            <th scope="col" className="hidden px-3 py-2 sm:table-cell">
              Email
            </th>
            <th scope="col" className="hidden px-3 py-2 md:table-cell">
              Phone
            </th>
            <th scope="col" className="hidden px-3 py-2 lg:table-cell">
              Notes
            </th>
            <th scope="col" className="px-3 py-2 text-right sm:text-left">
              <span className="sr-only">Status</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {parsed.rows.map((row, i) => {
            const status = statuses[i]!;
            const skipped = status.tone === 'muted' || status.tone === 'danger';
            const missing = (value: string, label: string) =>
              value ? value : <span className="text-fg-subtle italic">{label}</span>;
            return (
              <tr key={`${row.line}-${i}`} className={cn('border-t border-border align-top', skipped && 'text-fg-subtle')}>
                <td className="hidden px-3 py-2 text-xs text-fg-subtle tabular-nums sm:table-cell">{row.line}</td>
                <td className="max-w-44 px-3 py-2">
                  <span className={cn('block truncate', !skipped && 'font-medium text-fg')}>{missing(row.name, 'no name')}</span>
                  <span className="block truncate text-xs text-fg-muted sm:hidden">{missing(row.email, 'no email')}</span>
                  {row.phone && <span className="block truncate text-xs text-fg-muted md:hidden">{row.phone}</span>}
                </td>
                <td className={cn('hidden max-w-56 truncate px-3 py-2 sm:table-cell', !skipped && 'text-fg-muted')}>
                  {missing(row.email, 'missing')}
                </td>
                <td className={cn('hidden px-3 py-2 whitespace-nowrap md:table-cell', !skipped && 'text-fg-muted')}>{row.phone}</td>
                <td className={cn('hidden max-w-64 px-3 py-2 lg:table-cell', !skipped && 'text-fg-muted')}>
                  <span className="line-clamp-2 whitespace-pre-line" title={row.note || undefined}>
                    {row.note}
                  </span>
                </td>
                <td className="px-3 py-2 text-right sm:text-left">
                  <StatusPill status={status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
