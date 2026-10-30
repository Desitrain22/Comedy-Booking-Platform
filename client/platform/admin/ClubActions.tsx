/**
 * The club page's actions: Suspend (optional reason), Reactivate, Archive (type the address to
 * confirm), Restore, and Download backup. Which ones show depends on the club's status.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, CirclePause, CirclePlay, Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { AdminClubRow } from '../../../shared/api/platformAdmin';
import { Button, ConfirmDialog, Dialog, Field, Input, Textarea } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { ADMIN_KEY, downloadClubBackup, useAdminAction } from './adminApi';

type Open = 'suspend' | 'reactivate' | 'archive' | 'restore' | null;

export function ClubActions({ club }: { club: AdminClubRow }) {
  const queryClient = useQueryClient();
  const action = useAdminAction(club.id);
  const [open, setOpen] = useState<Open>(null);
  const [reason, setReason] = useState('');
  const [downloading, setDownloading] = useState(false);
  const close = () => setOpen(null);

  async function download() {
    setDownloading(true);
    try {
      const filename = await downloadClubBackup(club.id);
      toast.success(`Downloaded ${filename}`);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't download the backup"));
    } finally {
      setDownloading(false);
      void queryClient.invalidateQueries({ queryKey: [ADMIN_KEY, 'club', club.id] });
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {club.status === 'active' && (
        <Button variant="secondary" onClick={() => setOpen('suspend')}>
          <CirclePause aria-hidden /> Suspend
        </Button>
      )}
      {club.status === 'suspended' && (
        <Button onClick={() => setOpen('reactivate')}>
          <CirclePlay aria-hidden /> Reactivate
        </Button>
      )}
      {club.status === 'archived' ? (
        <Button onClick={() => setOpen('restore')}>
          <ArchiveRestore aria-hidden /> Restore
        </Button>
      ) : (
        <Button variant="secondary" onClick={() => setOpen('archive')}>
          <Archive aria-hidden /> Archive
        </Button>
      )}
      <Button variant="secondary" onClick={() => void download()} loading={downloading}>
        <Download aria-hidden /> Download backup
      </Button>

      <ConfirmDialog
        open={open === 'suspend'}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={`Suspend ${club.name}?`}
        description="Its bookers and comedians see a “paused” page and no emails go out. Nothing is deleted."
        confirmLabel="Suspend club"
        destructive
        onConfirm={async () => {
          await action.mutateAsync({ action: 'suspend', reason });
          setReason('');
          toast.success(`${club.name} is suspended`);
        }}
      >
        <Field label="Reason (optional)" hint="Only you see this.">
          <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={open === 'reactivate'}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={`Reactivate ${club.name}?`}
        description="Its bookers and comedians can use it again, and its emails start going out."
        confirmLabel="Reactivate"
        onConfirm={async () => {
          await action.mutateAsync({ action: 'reactivate' });
          toast.success(`${club.name} is active again`);
        }}
      />

      <ConfirmDialog
        open={open === 'restore'}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={`Restore ${club.name}?`}
        description={`It comes back as active at ${club.host}, with all its data.`}
        confirmLabel="Restore"
        onConfirm={async () => {
          await action.mutateAsync({ action: 'restore' });
          toast.success(`${club.name} is restored`);
        }}
      />

      <ArchiveDialog
        club={club}
        open={open === 'archive'}
        onClose={close}
        onArchive={async (confirmSlug) => {
          await action.mutateAsync({ action: 'archive', confirmSlug });
          toast.success(`${club.name} is archived`);
        }}
      />
    </div>
  );
}

function ArchiveDialog({
  club,
  open,
  onClose,
  onArchive,
}: {
  club: AdminClubRow;
  open: boolean;
  onClose: () => void;
  onArchive: (confirmSlug: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === club.slug;

  function handleOpenChange(next: boolean) {
    if (busy || next) return;
    setTyped('');
    setError(null);
    onClose();
  }

  async function confirm() {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await onArchive(typed.trim().toLowerCase());
      setTyped('');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={`Archive ${club.name}?`}
      description={`The club disappears and ${club.host} shows “no club at this address”. Its data is kept and you can restore it; the address stays reserved.`}
      size="sm"
      hideClose
      footer={
        <>
          <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={!matches} loading={busy}>
            Archive club
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <Field label={`Type ${club.slug} to confirm`}>
          <Input
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={club.slug}
          />
        </Field>
        {error && <p className="text-sm text-danger">{error}</p>}
      </form>
    </Dialog>
  );
}
