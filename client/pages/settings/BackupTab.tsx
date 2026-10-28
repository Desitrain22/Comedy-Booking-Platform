/** Settings → Backup (admins only): download a copy of the whole SQLite database. */
import { Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardBody, CardHeader } from '../../components/ui';
import { ApiError, apiUrl, errorMessage } from '../../lib/api';
import { Callout } from './SettingsParts';

function filenameFrom(disposition: string | null): string {
  return /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? 'club-backup.db';
}

/** Fetch the backup and hand it to the browser as a file download. */
async function downloadBackup(): Promise<string> {
  const res = await fetch(apiUrl('/backup'), { credentials: 'same-origin' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error: string; code?: string };
    throw new ApiError(res.status, body);
  }
  const filename = filenameFrom(res.headers.get('content-disposition'));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

export function BackupTab() {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  async function handleDownload() {
    setBusy(true);
    try {
      const filename = await downloadBackup();
      setLast(filename);
      toast.success(`Downloaded ${filename}`);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't download the backup"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Database backup"
          description="Everything lives in one SQLite file. Download a copy now and then — and always before upgrading."
        />
        <CardBody className="space-y-4">
          <p className="text-sm text-fg">
            The backup includes shows, lineups, comedians, availability, notes, bookers, the email log and settings.
          </p>
          <Callout tone="warning" title="Keep backups private">
            They contain everyone’s email addresses and your saved email password.
          </Callout>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void handleDownload()} loading={busy}>
              <Download aria-hidden /> Download database backup
            </Button>
            {last && (
              <span className="text-xs text-fg-muted" role="status">
                Saved as {last}
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Restoring a backup" />
        <CardBody>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-fg">
            <li>Stop the app.</li>
            <li>
              In the data folder (<code className="rounded bg-surface-2 px-1 font-mono text-xs">DATA_DIR</code>, or{' '}
              <code className="rounded bg-surface-2 px-1 font-mono text-xs">/data</code> in Docker), delete{' '}
              <code className="rounded bg-surface-2 px-1 font-mono text-xs">club.db-wal</code> and{' '}
              <code className="rounded bg-surface-2 px-1 font-mono text-xs">club.db-shm</code> if they exist.
            </li>
            <li>
              Replace <code className="rounded bg-surface-2 px-1 font-mono text-xs">club.db</code> with the backup file,
              renamed to <code className="rounded bg-surface-2 px-1 font-mono text-xs">club.db</code>.
            </li>
            <li>Start the app again.</li>
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}
