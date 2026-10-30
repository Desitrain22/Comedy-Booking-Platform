import { describe, expect, it } from 'vitest';
import { describeVia } from './emailProviders';
import {
  connectionDraftFrom,
  connectionPatch,
  isPassNeededAgain,
  withPort,
  withProvider,
  type SavedConnection,
} from './mailboxDraft';

const NONE: SavedConnection = { smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPassSet: false };
const GMAIL: SavedConnection = {
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: 'rich@gmail.com',
  smtpPassSet: true,
};
const from = (fromEmail = '') => ({ fromEmail, fromField: 'smtpFromEmail' });

describe('mailbox drafts', () => {
  it('starts from what is saved', () => {
    expect(connectionDraftFrom(NONE)).toMatchObject({ provider: null, smtpPort: '587', smtpPass: '', clearPass: false });
    expect(connectionDraftFrom(GMAIL)).toMatchObject({ provider: 'gmail', smtpHost: 'smtp.gmail.com', smtpPort: '465' });
  });

  it('fills in a preset, and picking the saved one restores it', () => {
    const draft = withProvider(connectionDraftFrom(GMAIL), GMAIL, 'resend');
    expect(draft).toMatchObject({ provider: 'resend', smtpHost: 'smtp.resend.com', smtpPort: '465', smtpUser: 'resend' });
    expect(withProvider(draft, GMAIL, 'gmail')).toMatchObject({ provider: 'gmail', smtpUser: 'rich@gmail.com' });
    // A fixed username doesn't carry over to another provider; a real one does.
    expect(withProvider(draft, GMAIL, 'custom').smtpUser).toBe('');
    expect(withProvider(connectionDraftFrom(GMAIL), NONE, 'custom').smtpUser).toBe('rich@gmail.com');
    // Extra fields of a wider draft survive.
    expect(withProvider({ ...connectionDraftFrom(NONE), smtpFromEmail: 'me@x.test' }, NONE, 'gmail').smtpFromEmail).toBe(
      'me@x.test',
    );
  });

  it('suggests the security setting for a port', () => {
    const draft = connectionDraftFrom(NONE);
    expect(withPort(draft, '465').smtpSecure).toBe(true);
    expect(withPort({ ...draft, smtpSecure: true }, '587').smtpSecure).toBe(false);
    expect(withPort({ ...draft, smtpSecure: true }, '2526').smtpSecure).toBe(true);
  });

  it('asks for the password again when the connection changes', () => {
    const draft = connectionDraftFrom(GMAIL);
    expect(isPassNeededAgain(GMAIL, draft)).toBe(false);
    expect(isPassNeededAgain(GMAIL, { ...draft, smtpUser: 'other@gmail.com' })).toBe(true);
    expect(isPassNeededAgain(GMAIL, { ...draft, smtpUser: 'other@gmail.com', clearPass: true })).toBe(false);
    expect(connectionPatch({ ...draft, smtpUser: 'other@gmail.com' }, GMAIL, from()).errors.smtpPass).toMatch(/again/);
  });

  it('builds the save: keeps a saved password, strips Gmail spaces, needs a From address', () => {
    expect(connectionPatch(connectionDraftFrom(GMAIL), GMAIL, from())).toEqual({
      patch: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true, smtpUser: 'rich@gmail.com' },
      errors: {},
    });
    const fresh = withProvider(connectionDraftFrom(NONE), NONE, 'gmail');
    expect(connectionPatch(fresh, NONE, from()).errors).toMatchObject({
      smtpUser: 'Enter the Gmail address you send from',
      smtpPass: 'Paste your App Password',
      smtpFromEmail: 'Enter the email address messages come from',
    });
    const filled = { ...fresh, smtpUser: 'rich@gmail.com', smtpPass: 'abcd efgh ijkl mnop' };
    expect(connectionPatch(filled, NONE, from()).patch.smtpPass).toBe('abcdefghijklmnop');

    // Resend's username isn't an address: the From email is needed.
    const resend = { ...withProvider(connectionDraftFrom(NONE), NONE, 'resend'), smtpPass: 're_1' };
    expect(connectionPatch(resend, NONE, from()).errors.smtpFromEmail).toBeDefined();
    expect(connectionPatch(resend, NONE, from('rich@bwaygroup.test')).errors).toEqual({});

    // Postmark: one token as username and password.
    const postmark = { ...withProvider(connectionDraftFrom(NONE), NONE, 'postmark'), smtpUser: 'tok-123' };
    expect(connectionPatch(postmark, NONE, from('rich@bwaygroup.test')).patch).toMatchObject({
      smtpUser: 'tok-123',
      smtpPass: 'tok-123',
    });
  });

  it('a blank provider means no mailbox', () => {
    expect(connectionPatch(connectionDraftFrom(NONE), NONE, from()).patch.smtpHost).toBe('');
    expect(connectionPatch({ ...connectionDraftFrom(GMAIL), provider: null, clearPass: true }, GMAIL, from()).patch).toMatchObject({
      smtpHost: '',
      clearSmtpPass: true,
    });
  });
});

describe('describeVia', () => {
  it('says how an email went out, and for whom', () => {
    expect(describeVia({ via: null, senderName: null })).toBe('');
    expect(describeVia({ via: 'platform', senderName: null })).toBe('Platform sender');
    expect(describeVia({ via: 'platform', senderName: 'Rich Brooks' })).toBe('Rich Brooks · Platform sender');
    expect(describeVia({ via: 'company-mailbox', senderName: null })).toBe('Company mailbox');
    expect(describeVia({ via: 'booker-mailbox', senderName: 'Rich Brooks' })).toBe('Rich Brooks’s mailbox');
    expect(describeVia({ via: 'booker-mailbox', senderName: null })).toBe('Booker\'s mailbox');
    expect(describeVia({ via: 'outbox', senderName: null })).toBe('Outbox');
  });
});
