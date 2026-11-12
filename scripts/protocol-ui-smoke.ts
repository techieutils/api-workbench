import { app, dialog, BrowserWindow, safeStorage } from 'electron';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  createHarness,
  pause,
  startServers,
  temporary,
  type ProtocolContext,
} from './protocol-ui-smoke/harness';
import { selectParts, type SmokePart } from './smoke-parts';
import layoutAndWebsocket from './protocol-ui-smoke/01-layout-and-websocket';
import sseAndNdjson from './protocol-ui-smoke/02-sse-and-ndjson';
import grpc from './protocol-ui-smoke/03-grpc';
import vaultAndSigning from './protocol-ui-smoke/04-vault-and-signing';
import persistenceAndLayout from './protocol-ui-smoke/05-persistence-and-layout';
import socketIOAndMQTT from './protocol-ui-smoke/06-socketio-and-mqtt';

// Live protocols (WebSocket, SSE, NDJSON, gRPC, Socket.IO, MQTT) against local servers. The checks are in
// protocol-ui-smoke/, one file per area, run in order against the same window.
app.setPath('userData', temporary);
// Test-only encryption prevents real OS keychain prompts.
const vaultKey = randomBytes(32);
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.getSelectedStorageBackend = () => 'unknown';
safeStorage.encryptStringAsync = async (value) => {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
  return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
};
safeStorage.decryptStringAsync = async (value) => {
  const decipher = createDecipheriv('aes-256-gcm', vaultKey, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(-16));
  return {
    result: Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(),
    shouldReEncrypt: false,
  };
};
// The main process asks before HTTPS decryption or trusting a certificate, in a
// native dialog (packages/api-workbench-electron/src/confirmations.ts); tests answer yes.
dialog.showMessageBox = (async () => ({
  response: 0,
  checkboxChecked: false,
})) as typeof dialog.showMessageBox;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Register startup synchronously.
require('@techieutils/api-workbench-electron/bootstrap');
const watchdog = setTimeout(() => {
  console.error('Protocol UI watchdog expired');
  app.exit(1);
}, 45000);
/** Every area of the live protocols, in the order a full run checks them; see smoke-parts.ts. */
const PARTS: SmokePart<ProtocolContext>[] = [
  ['layout-and-websocket', layoutAndWebsocket],
  ['sse-and-ndjson', sseAndNdjson],
  ['grpc', grpc],
  ['vault-and-signing', vaultAndSigning],
  ['persistence-and-layout', persistenceAndLayout],
  ['socketio-and-mqtt', socketIOAndMQTT],
];
const parts = selectParts(PARTS);
app
  .whenReady()
  .then(async () => {
    let exitCode = 0;
    let window: BrowserWindow | undefined;
    let servers: Awaited<ReturnType<typeof startServers>> | undefined;
    try {
      servers = await startServers();
      for (let attempt = 0; !BrowserWindow.getAllWindows().length && attempt < 250; attempt++)
        await pause(20);
      window = BrowserWindow.getAllWindows()[0];
      window.removeAllListeners('ready-to-show');
      window.hide();
      window.webContents.setBackgroundThrottling(false);
      const errors: string[] = [];
      window.webContents.on('console-message', ({ level, message }) => {
        if (level === 'error') errors.push(message);
      });
      const context = createHarness(window, servers);
      await context.prepare();
      for (const part of parts.selected) {
        console.log(`Part ${part.number}: ${part.name}`);
        await part.run(context);
      }
      assert.deepEqual(errors, [], 'no protocol renderer errors');
      if (!parts.all)
        console.log(
          `Protocol UI checks passed for ${parts.selected.map((part) => `${part.number} ${part.name}`).join(', ')}.`,
        );
      else
        console.log(
          'Protocol UI checks passed: selector, WebSocket text/binary, tab lifecycle, live SSE/NDJSON, gRPC discovery and all four call types, persistence, import, and vault and inline signing.',
        );
    } catch (error) {
      console.error(error);
      exitCode = 1;
    } finally {
      clearTimeout(watchdog);
      window?.destroy();
      await servers?.close();
      await pause(50);
      rmSync(temporary, { recursive: true, force: true });
      app.exit(exitCode);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
