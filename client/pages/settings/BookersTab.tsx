/**
 * Settings → Bookers (admins only): who can sign in to the booker app. Invite (shows a
 * copyable invite link), resend invites, change roles, remove.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Link2, Mail, Trash2, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { BookerUserDto, InviteResponse, InviteUserInput } from '../../../shared/api/settings';
import { emailSchema } from '../../../shared/schemas';
import { formatRelative } from '../../../shared/time';
import type { Role } from '../../../shared/types';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  PageSpinner,
  Select,
  Switch,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useBooker, useRefreshMe } from '../../lib/useMe';
import { Callout, CopyField } from './SettingsParts';
import { EMAIL_LOG_KEY, USERS_KEY } from './settingsData';

const ROLE_OPTIONS: { value: Role; label: string; description: string }[] = [
  { value: 'booker', label: 'Booker', description: 'Books shows, manages comedians, and edits club settings.' },
  { value: 'admin', label: 'Admin', description: 'Everything a booker can do, plus managing bookers and backups.' },
];

const DAY_MS = 86_400_000;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function BookersTab() {
  const me = useBooker();
  const refreshMe = useRefreshMe();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: ({ signal }) => api.get<BookerUserDto[]>('/users', { signal }) });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [linkResult, setLinkResult] = useState<InviteResponse | null>(null);
  const [removing, setRemoving] = useState<BookerUserDto | null>(null);
  const [demotingSelf, setDemotingSelf] = useState(false);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: USERS_KEY }),
      queryClient.invalidateQueries({ queryKey: EMAIL_LOG_KEY }),
    ]);

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: Role }) => api.patch<BookerUserDto>(`/users/${id}`, { role }),
    onSuccess: async (user) => {
      queryClient.setQueryData<BookerUserDto[]>(USERS_KEY, (list) => list?.map((u) => (u.id === user.id ? user : u)));
      toast.success(`${user.name} is now ${user.role === 'admin' ? 'an admin' : 'a booker'}`);
      if (user.id === me.id) await refreshMe();
    },
  });

  const resend = useMutation({
    mutationFn: ({ id, sendEmail }: { id: number; sendEmail: boolean }) =>
      api.post<InviteResponse>(`/users/${id}/resend-invite`, { sendEmail }),
    onSuccess: (res) => {
      setLinkResult(res);
      return invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/users/${id}`),
    meta: { silent: true },
    onSuccess: () => invalidate(),
  });

  if (!users.data) return <PageSpinner />;
  const activeAdmins = users.data.filter((u) => u.role === 'admin' && u.status === 'active').length;

  function handleRoleChange(user: BookerUserDto, role: Role) {
    if (user.id === me.id && role !== 'admin') return setDemotingSelf(true);
    changeRole.mutate({ id: user.id, role });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Bookers"
          description="Club staff who can sign in here. Comedians don't need an account — they use the portal."
          actions={
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus aria-hidden /> Invite booker
            </Button>
          }
        />
        {users.data.length === 0 ? (
          <EmptyState icon={Users} title="No bookers yet" />
        ) : (
          <ul className="divide-y divide-border">
            {users.data.map((user) => {
              const isMe = user.id === me.id;
              const lastAdmin = user.role === 'admin' && user.status === 'active' && activeAdmins <= 1;
              const pending = user.status !== 'active';
              return (
                <li key={user.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <Avatar name={user.name} size="md" />
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="flex items-center gap-2 truncate font-medium text-fg">
                      <span className="truncate">{user.name}</span>
                      {isMe && <Badge variant="accent">You</Badge>}
                    </p>
                    <p className="truncate text-xs text-fg-muted">{user.email}</p>
                  </div>
                  <UserStatus user={user} />
                  <Select
                    aria-label={`Role for ${user.name}`}
                    value={user.role}
                    options={ROLE_OPTIONS}
                    disabled={lastAdmin || (changeRole.isPending && changeRole.variables?.id === user.id)}
                    title={lastAdmin ? 'The club needs at least one admin' : undefined}
                    onChange={(e) => handleRoleChange(user, e.target.value as Role)}
                    wrapperClassName="w-28"
                  />
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`More actions for ${user.name}`}>
                        <Ellipsis aria-hidden />
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      {pending && (
                        <>
                          <MenuItem onSelect={() => resend.mutate({ id: user.id, sendEmail: true })}>
                            <Mail /> Resend invite email
                          </MenuItem>
                          <MenuItem onSelect={() => resend.mutate({ id: user.id, sendEmail: false })}>
                            <Link2 /> Get a new invite link
                          </MenuItem>
                          <MenuSeparator />
                        </>
                      )}
                      <MenuItem
                        destructive
                        disabled={isMe || lastAdmin}
                        onSelect={() => setRemoving(user)}
                      >
                        <Trash2 /> {pending ? 'Cancel invite' : 'Remove'}
                        {isMe && <span className="ml-auto text-xs text-fg-subtle">(you)</span>}
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={() => void invalidate()}
      />

      <Dialog
        open={linkResult !== null}
        onOpenChange={(open) => !open && setLinkResult(null)}
        title={linkResult ? `New invite link for ${linkResult.user.name}` : 'Invite link'}
        footer={<Button onClick={() => setLinkResult(null)}>Done</Button>}
      >
        {linkResult && <InviteLinkPanel result={linkResult} />}
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          removing?.status === 'active' ? `Remove ${removing.name}?` : `Cancel ${removing?.name ?? 'this'}'s invite?`
        }
        description={
          removing?.status === 'active'
            ? "They're signed out right away and can't sign in again. Their notes and bookings stay."
            : 'The invite link stops working. You can invite them again later.'
        }
        confirmLabel={removing?.status === 'active' ? 'Remove' : 'Cancel invite'}
        cancelLabel="Keep"
        destructive
        onConfirm={() => {
          const target = removing!;
          return remove
            .mutateAsync(target.id)
            .then(() =>
              toast.success(target.status === 'active' ? `${target.name} removed` : `${target.name}'s invite cancelled`),
            );
        }}
      />

      <ConfirmDialog
        open={demotingSelf}
        onOpenChange={setDemotingSelf}
        title="Make yourself a booker?"
        description="You'll lose access to Bookers and Backup. Another admin can make you an admin again."
        confirmLabel="Make me a booker"
        onConfirm={() => changeRole.mutateAsync({ id: me.id, role: 'booker' })}
      />
    </div>
  );
}

function UserStatus({ user }: { user: BookerUserDto }) {
  if (user.status === 'invited') {
    const days = Math.max(1, Math.ceil(((user.inviteExpiresAt ?? 0) - Date.now()) / DAY_MS));
    return (
      <span className="flex flex-col items-end text-right">
        <Badge variant="warning">Invited</Badge>
        <span className="mt-0.5 text-xs text-fg-muted">
          Expires in {days} day{days === 1 ? '' : 's'}
        </span>
      </span>
    );
  }
  if (user.status === 'invite_expired') {
    return (
      <span className="flex flex-col items-end text-right">
        <Badge variant="danger">Invite expired</Badge>
        <span className="mt-0.5 text-xs text-fg-muted">Send a new one from ⋯</span>
      </span>
    );
  }
  return (
    <span className="text-right text-xs text-fg-muted">
      {user.lastLoginAt ? `Signed in ${formatRelative(user.lastLoginAt)}` : 'Never signed in'}
    </span>
  );
}

function InviteLinkPanel({ result }: { result: InviteResponse }) {
  const name = firstName(result.user.name);
  const { status, error } = result.email;
  return (
    <div className="space-y-4">
      {status === 'sent' && (
        <Callout live tone="success" title={`We emailed the invite to ${result.user.email}`}>
          You can also send {name} the link yourself.
        </Callout>
      )}
      {status === 'outbox' && (
        <Callout live tone="warning" title="Email isn't set up, so the invite wasn't sent">
          Copy the link below and send it to {name} yourself (text, chat, or your own email).
        </Callout>
      )}
      {status === 'failed' && (
        <Callout live tone="danger" title="The invite email couldn't be sent">
          {error && <p className="font-mono text-xs break-words">{error}</p>}
          <p>Copy the link below and send it to {name} yourself.</p>
        </Callout>
      )}
      {status === 'skipped' && (
        <p className="text-sm text-fg-muted">Send this link to {name} yourself.</p>
      )}
      <Field label="Invite link" hint={`Works once, for 7 days. ${name} opens it to set a password.`}>
        <CopyField value={result.inviteUrl} label="Invite link" />
      </Field>
    </div>
  );
}

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}

function InviteDialog({ open, onOpenChange, onInvited }: InviteDialogProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('booker');
  const [sendEmail, setSendEmail] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; email?: string; form?: string }>({});
  const [result, setResult] = useState<InviteResponse | null>(null);

  const invite = useMutation({
    mutationFn: (input: InviteUserInput) => api.post<InviteResponse>('/users', input),
    onSuccess: (res) => {
      setResult(res);
      onInvited();
    },
    onError: (err) => {
      const message = errorMessage(err);
      setErrors(/email/i.test(message) ? { email: message } : { form: message });
    },
  });

  function resetForm() {
    setName('');
    setEmail('');
    setRole('booker');
    setSendEmail(true);
    setErrors({});
    setResult(null);
    invite.reset();
  }

  function handleOpenChange(next: boolean) {
    if (invite.isPending) return;
    onOpenChange(next);
    if (!next) window.setTimeout(resetForm, 150);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const found: typeof errors = {};
    if (!name.trim()) found.name = 'Enter their name';
    if (!emailSchema.safeParse(email).success) found.email = 'Enter a valid email address';
    setErrors(found);
    if (Object.keys(found).length) return;
    invite.mutate({ name, email, role, sendEmail });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={result ? `${firstName(result.user.name)} is invited` : 'Invite a booker'}
      description={result ? undefined : "They'll get a link to set their own password."}
      footer={
        result ? (
          <>
            <Button variant="secondary" onClick={resetForm}>
              Invite someone else
            </Button>
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={invite.isPending}>
              Cancel
            </Button>
            <Button type="submit" form="invite-booker-form" loading={invite.isPending}>
              {sendEmail ? 'Send invite' : 'Create invite link'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <InviteLinkPanel result={result} />
      ) : (
        <form id="invite-booker-form" onSubmit={handleSubmit} noValidate className="space-y-4">
          <Field label="Name" error={errors.name}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Sam Rivera" />
          </Field>
          <Field label="Email" error={errors.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="sam@yourclub.com"
              autoComplete="off"
            />
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-[13px] font-medium text-fg">Role</legend>
            {ROLE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                  role === option.value ? 'border-accent bg-accent-soft' : 'border-border-strong hover:bg-surface-2/60',
                )}
              >
                <input
                  type="radio"
                  name="invite-role"
                  value={option.value}
                  checked={role === option.value}
                  onChange={() => setRole(option.value)}
                  className="mt-0.5 accent-[var(--accent-solid)]"
                />
                <span>
                  <span className="block text-sm font-medium text-fg">{option.label}</span>
                  <span className="block text-xs text-fg-muted">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Switch checked={sendEmail} onCheckedChange={setSendEmail} label="Email them the invite" />
          {errors.form && <p className="text-sm text-danger">{errors.form}</p>}
        </form>
      )}
    </Dialog>
  );
}
