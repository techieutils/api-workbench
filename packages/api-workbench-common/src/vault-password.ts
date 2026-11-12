/**
 * The API Workbench vault's password rules, shared so the app can say what a password needs while
 * it is typed and the main process enforces the same rules.
 */
export const MIN_VAULT_PASSWORD_LENGTH = 12;

/** What a password needs, in words; undefined when it is strong enough. */
export function vaultPasswordProblem(password: unknown): string | undefined {
  if (typeof password !== 'string' || password.length < MIN_VAULT_PASSWORD_LENGTH)
    return `Use at least ${MIN_VAULT_PASSWORD_LENGTH} characters.`;
  if (password.length > 1024) return 'Use a password of 1,024 characters or fewer.';
  if (/^(.)\1+$/.test(password)) return 'Do not repeat one character.';
  if (vaultPasswordKinds(password) < 2 && password.length < 20)
    return 'Mix letters with numbers or symbols, or use a passphrase of 20 characters or more.';
  return undefined;
}
/** How many kinds of character a password uses: lowercase, uppercase, digits, and others. */
const vaultPasswordKinds = (password: string) =>
  [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((kind) => kind.test(password)).length;

/** How strong a password looks, from 0 (too weak to use) to 3 (strong), for a meter. */
export function vaultPasswordStrength(password: string): 0 | 1 | 2 | 3 {
  if (vaultPasswordProblem(password)) return 0;
  const score =
    (password.length >= 16 ? 1 : 0) +
    (password.length >= 24 ? 1 : 0) +
    (vaultPasswordKinds(password) >= 3 ? 1 : 0);
  return score >= 2 ? 3 : score === 1 ? 2 : 1;
}
