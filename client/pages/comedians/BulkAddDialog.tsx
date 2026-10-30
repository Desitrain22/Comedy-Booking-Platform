import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  BULK_ADD_MAX,
  BULK_SKIP_LABELS,
  checkBulkRows,
  parseBulkLines,
  type BulkAddResult,
  type BulkSkip,
  type BulkSkipReason,
} from '../../../shared/api/comedians';
import { Badge, Button, Dialog, Spinner, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useBooker } from '../../lib/useMe';
import { bulkLinksToast } from './loginLinks';
import { invalidateComedians } from './queries';
import { SendLinkCheckbox } from './SendLinkCheckbox';

export interface BulkAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PLACEHOLDER = `Jason Lee, jason@example.com
Maria Gomez <maria@example.com>
Sam Jones, sam@example.com`;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

type RowStatus = { kind: 'new' } | { kind: 'skip'; reason: BulkSkipReason; detail?: string };

/**
 * Paste `Name, email` / `Name <email>` lines → live preview (invalid/duplicate flagged) →
 * create, emailing each new comedian a sign-in link unless unchecked.
 */
export function BulkAddDialog({ open, onOpenChange }: BulkAddDialogProps) {
  const queryClient = useQueryClient();
  const isAdmin = useBooker().role === 'admin';
  const [text, setText] = useState('');
  const [sendLinks, setSendLinks] = useState(true);

  const parsed = useMemo(() => parseBulkLines(text), [text]);
  const rows = useMemo(() => parsed.map(({ name, email }) => ({ name, email })), [parsed]);
  const local = useMemo(() => checkBulkRows(rows), [rows]);
  const rowsKey = JSON.stringify(rows);
  const debouncedKey = useDebounced(rowsKey, 300);
  const tooMany = rows.length > BULK_ADD_MAX;

  // Server dry run: adds "already on roster" to the local checks.
  const preview = useQuery({
    queryKey: ['comedians', 'bulk-preview', debouncedKey],
    queryFn: () => api.post<BulkAddResult>('/comedians/bulk', { rows: JSON.parse(debouncedKey) as unknown, dryRun: true }),
    enabled: open && rows.length > 0 && !tooMany && debouncedKey === rowsKey,
    staleTime: 0,
    gcTime: 30_000,
  });
  const serverSkips = useMemo(() => {
    const map = new Map<number, BulkSkip>();
    if (preview.data && debouncedKey === rowsKey) for (const s of preview.data.skipped) map.set(s.index, s);
    return map;
  }, [preview.data, debouncedKey, rowsKey]);
  const checking = rows.length > 0 && !tooMany && (debouncedKey !== rowsKey || preview.isFetching);

  const statuses: RowStatus[] = rows.map((_, i) => {
    const reason = local[i];
    if (reason) return { kind: 'skip', reason };
    const skip = serverSkips.get(i);
    if (skip) {
      const detail = skip.existing ? `${skip.existing.name}${skip.existing.archived ? ' (archived)' : ''}` : undefined;
      return { kind: 'skip', reason: skip.reason, detail };
    }
    return { kind: 'new' };
  });
  const newCount = statuses.filter((s) => s.kind === 'new').length;
  const skipCount = statuses.length - newCount;

  const create = useMutation({
    mutationFn: () => api.post<BulkAddResult>('/comedians/bulk', { rows, sendLoginLinks: sendLinks }),
    onSuccess: (result) => {
      invalidateComedians(queryClient);
      const added = result.created.length;
      const skipped = result.skipped.length;
      const lead = `Added ${added} comedian${added === 1 ? '' : 's'}${skipped ? ` · skipped ${skipped}` : ''}`;
      if (added === 0) toast.info(`Nothing added — all ${skipped} rows were skipped.`);
      else if (result.loginLinks) {
        const t = bulkLinksToast(lead, result.loginLinks, isAdmin);
        toast[t.tone](t.title, { description: t.description });
      } else toast.success(lead);
      close(false);
    },
  });

  function close(next: boolean) {
    if (!next) {
      setText('');
      setSendLinks(true);
      create.reset();
    }
    onOpenChange(next);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Bulk add comedians"
      description={
        <>
          Paste one comedian per line as <code className="rounded bg-surface-2 px-1 text-fg">Name, email</code> or{' '}
          <code className="rounded bg-surface-2 px-1 text-fg">Name &lt;email&gt;</code>. Rows with problems are skipped.
        </>
      }
      size="lg"
      footer={
        <>
          <p className="mr-auto hidden text-xs text-fg-muted sm:block" aria-live="polite">
            {rows.length === 0
              ? 'Nothing pasted yet'
              : tooMany
                ? `Too many rows — add at most ${BULK_ADD_MAX} at a time`
                : `${newCount} to add${skipCount ? ` · ${skipCount} skipped` : ''}`}
          </p>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={newCount === 0 || tooMany || checking}
          >
            {newCount > 0 ? `Add ${newCount} comedian${newCount === 1 ? '' : 's'}` : 'Add comedians'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={7}
          spellCheck={false}
          autoFocus
          aria-label="Comedians to add, one per line"
          className="font-mono text-[13px] sm:text-[13px]"
        />

        <SendLinkCheckbox checked={sendLinks} onChange={setSendLinks} many />

        {rows.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium text-fg">Preview</h3>
              <Badge variant="success">{newCount} new</Badge>
              {skipCount > 0 && <Badge variant="danger">{skipCount} skipped</Badge>}
              {checking && <Spinner className="ml-auto size-4" label="Checking the roster" />}
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-surface-2 text-xs text-fg-muted">
                  <tr>
                    <th scope="col" className="w-12 px-3 py-1.5 font-medium">
                      Line
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-medium">
                      Email
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map((row, i) => {
                    const status = statuses[i]!;
                    const skip = status.kind === 'skip';
                    return (
                      <tr key={`${row.line}-${i}`} className={cn('border-t border-border', skip && 'bg-danger-soft/40')}>
                        <td className="px-3 py-1.5 text-xs text-fg-subtle tabular-nums">{row.line}</td>
                        <td className={cn('max-w-40 truncate px-3 py-1.5', !row.name && 'text-fg-subtle italic')}>
                          {row.name || 'no name'}
                        </td>
                        <td className={cn('max-w-56 truncate px-3 py-1.5 text-fg-muted', !row.email && 'text-fg-subtle italic')}>
                          {row.email || 'no email'}
                        </td>
                        <td className="px-3 py-1.5">
                          {status.kind === 'new' ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-confirmed-fg">
                              <CircleCheck className="size-3.5" aria-hidden /> New
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 text-xs font-medium text-danger"
                              title={status.detail}
                            >
                              <CircleAlert className="size-3.5" aria-hidden />
                              {status.reason === 'invalid_email' && !row.email ? 'Missing email' : BULK_SKIP_LABELS[status.reason]}
                              {status.detail && <span className="font-normal text-fg-muted">· {status.detail}</span>}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
