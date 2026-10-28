/**
 * "Jason Park isn't available during this slot. Book anyway?" — shown before booking or
 * moving someone into a show they didn't mark (spec §6 F2). Confirming retries with force.
 */
import type { UnavailableConflict } from '../../../shared/api/lineup';
import { ConfirmDialog } from '../../components/ui';
import { unavailableReason } from './lineupModel';

export interface PendingConflict {
  conflicts: UnavailableConflict[];
  confirm: () => void;
}

export function UnavailableDialog({ pending, onClose }: { pending: PendingConflict | null; onClose: () => void }) {
  const conflicts = pending?.conflicts ?? [];
  const single = conflicts.length === 1 ? conflicts[0] : null;
  return (
    <ConfirmDialog
      open={pending != null}
      onOpenChange={(open) => !open && onClose()}
      title={
        single ? (
          <>
            <strong className="font-semibold">{single.comedianName}</strong> isn’t available during this slot
          </>
        ) : (
          'These comedians aren’t available for those slots'
        )
      }
      description={single ? `${unavailableReason(single)} Book anyway?` : undefined}
      confirmLabel="Book anyway"
      onConfirm={() => pending?.confirm()}
    >
      {!single && conflicts.length > 0 && (
        <>
          <ul className="space-y-1.5 text-sm text-fg-muted">
            {conflicts.map((c) => (
              <li key={c.comedianId}>
                <strong className="font-medium text-fg">{c.comedianName}</strong>: {unavailableReason(c)}
              </li>
            ))}
          </ul>
          <p className="text-sm text-fg-muted">Book anyway?</p>
        </>
      )}
    </ConfirmDialog>
  );
}
