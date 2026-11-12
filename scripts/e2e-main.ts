import { app, dialog, safeStorage } from 'electron';

/**
 * The app as Playwright starts it (see e2e/fixtures.ts). Its data goes to the throwaway folder
 * the test names, never the person's profile, and the operating system's credential store is
 * reported unavailable, as in the UI smoke runs, so no test reads or prompts for the keychain.
 */
const data = process.env.API_WORKBENCH_E2E_DATA;
if (!data) throw new Error('Set API_WORKBENCH_E2E_DATA to a temporary folder for the app’s data.');
app.setPath('userData', data);
safeStorage.isAsyncEncryptionAvailable = async () => false;
safeStorage.getSelectedStorageBackend = () => 'unknown';
// A stand-in for the system's store, for tests that move credentials between it and the API
// Workbench vault: reversible and plainly not encryption, so it never touches the real keychain.
if (process.env.API_WORKBENCH_E2E_OS_STORE) {
  const TAG = 'e2e-os:';
  safeStorage.isAsyncEncryptionAvailable = async () => true;
  safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
  safeStorage.encryptStringAsync = async (text: string) =>
    Buffer.from(`${TAG}${Buffer.from(text).toString('base64')}`);
  safeStorage.decryptStringAsync = async (data: Buffer) => {
    const text = data.toString();
    if (!text.startsWith(TAG)) throw new Error('Not encrypted by the test store.');
    return {
      result: Buffer.from(text.slice(TAG.length), 'base64').toString(),
      shouldReEncrypt: false,
    };
  };
}
// The main process asks before HTTPS decryption or trusting a certificate, in a
// native dialog (packages/api-workbench-electron/src/confirmations.ts); tests answer yes.
dialog.showMessageBox = (async () => ({
  response: 0,
  checkboxChecked: false,
})) as typeof dialog.showMessageBox;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Load the app only after its data folder is set.
require('@techieutils/api-workbench-electron/bootstrap');
