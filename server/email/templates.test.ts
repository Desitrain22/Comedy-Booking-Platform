import { describe, expect, it } from 'vitest';
import { loginCodeEmail } from './templates';

describe('loginCodeEmail', () => {
  it('reads naturally for club names starting with "The" (ux#C15)', () => {
    const email = loginCodeEmail({ clubName: 'The Laugh Track', name: 'John Mercer', code: '123456' });
    expect(email.subject).toBe('123456 is your sign-in code for The Laugh Track');
    expect(email.text).toContain('Your sign-in code for The Laugh Track is: 123456');
    expect(email.html).toContain('123456');
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain('your The Laugh Track');
      expect(part).not.toContain('the The Laugh Track');
    }
  });
});
