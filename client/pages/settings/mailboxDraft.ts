/**
 * Form state for an SMTP mailbox connection: the company's (Settings → Email) and each
 * booker's own (Settings → Account) use the same provider presets and rules. Pure, so it
 * can be unit-tested.
 *
 * The server drops a saved password when the server, port, security or username changes
 * without it being typed again, so the forms ask for it again in that case.
 */
import { emailSchema } from '../../../shared/schemas';
import { detectEmailProvider, getEmailProvider, secureForPort, type EmailProviderId } from './emailProviders';

/** A saved connection, as the API shows it (the password only as `smtpPassSet`). */
export interface SavedConnection {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassSet: boolean;
}

export interface ConnectionDraft {
  /** The chosen preset; null = no mailbox. */
  provider: EmailProviderId | null;
  smtpHost: string;
  /** Text in the input; converted on save. */
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  /** A new password ('' keeps the saved one). */
  smtpPass: string;
  /** Remove the saved password on save. */
  clearPass: boolean;
}

/** The connection fields of a save. */
export interface ConnectionPatch {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass?: string;
  clearSmtpPass?: boolean;
}

export type ConnectionErrors = Partial<Record<string, string>>;

export function connectionDraftFrom(saved: SavedConnection): ConnectionDraft {
  return {
    provider: detectEmailProvider(saved.smtpHost),
    smtpHost: saved.smtpHost,
    smtpPort: String(saved.smtpPort),
    smtpSecure: saved.smtpSecure,
    smtpUser: saved.smtpUser,
    smtpPass: '',
    clearPass: false,
  };
}

/** The saved password won't survive this draft unless it's typed again (see the server). */
export function isPassNeededAgain(saved: SavedConnection, draft: ConnectionDraft): boolean {
  return (
    saved.smtpPassSet &&
    !draft.clearPass &&
    ((draft.provider ? draft.smtpHost.trim() : '') !== saved.smtpHost ||
      Number(draft.smtpPort) !== saved.smtpPort ||
      draft.smtpSecure !== saved.smtpSecure ||
      draft.smtpUser.trim() !== saved.smtpUser)
  );
}

/** Pick a provider preset (picking the saved one again restores what's saved). */
export function withProvider<T extends ConnectionDraft>(draft: T, saved: SavedConnection, id: EmailProviderId): T {
  const preset = getEmailProvider(id);
  if (id === detectEmailProvider(saved.smtpHost)) {
    const back = connectionDraftFrom(saved);
    return {
      ...draft,
      provider: back.provider,
      smtpHost: back.smtpHost,
      smtpPort: back.smtpPort,
      smtpSecure: back.smtpSecure,
      smtpUser: back.smtpUser,
    };
  }
  const previous = getEmailProvider(draft.provider ?? 'custom');
  // A fixed username or token from another provider is meaningless here.
  const keepUser = !preset.tokenAsUserAndPass && !previous.fixedUser && !previous.tokenAsUserAndPass;
  return {
    ...draft,
    provider: id,
    smtpHost: preset.host,
    smtpPort: String(preset.port),
    smtpSecure: preset.secure,
    smtpUser: preset.fixedUser ?? (keepUser ? draft.smtpUser : ''),
  };
}

/** Change the port, suggesting the usual security setting for it. */
export function withPort<T extends ConnectionDraft>(draft: T, value: string): T {
  const suggested = secureForPort(Number(value));
  return { ...draft, smtpPort: value, smtpSecure: suggested ?? draft.smtpSecure };
}

/**
 * The connection part of a save and any field errors. `fromEmail` is the From address the
 * form will save (blank = the username); its error goes under `fromField`.
 */
export function connectionPatch(
  draft: ConnectionDraft,
  saved: SavedConnection,
  from: { fromEmail: string; fromField: string },
): { patch: ConnectionPatch; errors: ConnectionErrors } {
  const provider = draft.provider ? getEmailProvider(draft.provider) : null;
  const passNeededAgain = isPassNeededAgain(saved, draft);
  const patch: ConnectionPatch = {
    smtpHost: draft.provider ? draft.smtpHost.trim() : '',
    smtpPort: Number(draft.smtpPort),
    smtpSecure: draft.smtpSecure,
    smtpUser: draft.smtpUser.trim(),
  };
  const errors: ConnectionErrors = {};
  if (provider?.tokenAsUserAndPass) {
    if (!patch.smtpUser) errors.smtpUser = `Paste your ${provider.userLabel}`;
    else if (patch.smtpUser !== saved.smtpUser || !saved.smtpPassSet || passNeededAgain) {
      patch.smtpPass = patch.smtpUser;
    }
  } else {
    const pass = provider?.stripPassSpaces ? draft.smtpPass.replace(/\s+/g, '') : draft.smtpPass;
    const hasPassword = saved.smtpPassSet && !draft.clearPass && !passNeededAgain;
    if (pass) patch.smtpPass = pass;
    else if (draft.clearPass) patch.clearSmtpPass = true;
    if (!pass && !hasPassword && provider && (provider.id !== 'custom' || (passNeededAgain && patch.smtpUser))) {
      errors.smtpPass = passNeededAgain
        ? `Enter the ${provider.passLabel.toLowerCase()} again — needed when the server, port or username changes`
        : `Paste your ${provider.passLabel}`;
    }
  }
  if (provider) {
    if (!patch.smtpHost) errors.smtpHost = 'Enter the SMTP server, like smtp.yourprovider.com';
    if (provider.id === 'gmail' && !patch.smtpUser) errors.smtpUser = 'Enter the Gmail address you send from';
    if (!emailSchema.safeParse(from.fromEmail || patch.smtpUser).success) {
      errors[from.fromField] = 'Enter the email address messages come from';
    }
  }
  return { patch, errors };
}
