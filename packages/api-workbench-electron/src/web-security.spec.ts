import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import {
  fromAppWindow,
  guardWebContents,
  permissionAllowed,
  restrictPermissions,
  type PermissionSession,
} from './web-security';

test('only the app window may use the clipboard, and nothing else is granted', () => {
  assert.equal(permissionAllowed('clipboard-read', true), true);
  assert.equal(permissionAllowed('clipboard-sanitized-write', true), true);
  assert.equal(permissionAllowed('clipboard-read', false), false);
  for (const permission of [
    'media',
    'geolocation',
    'notifications',
    'openExternal',
    'fullscreen',
    'serial',
    'hid',
    'usb',
    'midiSysex',
    'pointerLock',
    'display-capture',
  ])
    assert.equal(permissionAllowed(permission, true), false, permission);
});

test('permission requests and checks both go through the policy', () => {
  const app = {};
  let request!: Parameters<PermissionSession['setPermissionRequestHandler']>[0];
  let check!: Parameters<PermissionSession['setPermissionCheckHandler']>[0];
  restrictPermissions(
    {
      setPermissionRequestHandler: (handler) => (request = handler),
      setPermissionCheckHandler: (handler) => (check = handler),
    },
    (contents) => contents === app,
  );
  const granted: boolean[] = [];
  request(app, 'clipboard-read', (value) => granted.push(value));
  request(app, 'media', (value) => granted.push(value));
  request({}, 'clipboard-read', (value) => granted.push(value));
  assert.deepEqual(granted, [true, false, false]);
  assert.deepEqual(
    [
      check(app, 'clipboard-sanitized-write'),
      check(app, 'geolocation'),
      check(null, 'clipboard-read'),
    ],
    [true, false, false],
  );
});

test('web contents cannot open windows, navigate, or attach a webview', () => {
  const contents = new EventEmitter() as EventEmitter & {
    openHandler?: () => { action: string };
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  };
  contents.setWindowOpenHandler = (handler) => (contents.openHandler = handler);
  guardWebContents(contents as unknown as WebContents);
  assert.deepEqual(contents.openHandler?.(), { action: 'deny' });
  for (const name of ['will-navigate', 'will-attach-webview']) {
    let prevented = false;
    contents.emit(name, { preventDefault: () => (prevented = true) });
    assert.equal(prevented, true, name);
  }
});

test('IPC is answered only for the app window’s top frame', () => {
  const mainFrame = {};
  const appWindow = { mainFrame };
  assert.equal(fromAppWindow({ sender: appWindow, senderFrame: mainFrame }, appWindow), true);
  // A frame inside the page, such as a response preview.
  assert.equal(fromAppWindow({ sender: appWindow, senderFrame: {} }, appWindow), false);
  // A frame that has gone away.
  assert.equal(fromAppWindow({ sender: appWindow, senderFrame: null }, appWindow), false);
  // Another window.
  assert.equal(fromAppWindow({ sender: {}, senderFrame: mainFrame }, appWindow), false);
  // Before the window exists, or after it closed.
  assert.equal(fromAppWindow({ sender: appWindow, senderFrame: mainFrame }, undefined), false);
});

test('the main process opens outside links in one place, which passes only web and mail links', () => {
  // Opening `file:`, `smb:`, or another app's scheme can start a program, so every call goes
  // through openWebLink and its isExternalLink check: the renderer's links and OAuth sign-in pages.
  const main = readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  assert.equal(main.match(/shell\.openExternal\(/g)?.length, 1);
  assert.match(
    main,
    /async function openWebLink\(url: unknown\): Promise<void> \{\n\s+if \(typeof url !== 'string' \|\| !isExternalLink\(url\)\)/,
  );
});

test('HTTPS decryption and trusting the certificate are confirmed in main', () => {
  // Each is asked in a native dialog the page cannot answer (confirmations.ts) before it happens.
  const main = readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const handler = (channel: string) => {
    const start = main.indexOf(`'${channel}'`);
    assert.ok(start > 0, channel);
    return main.slice(start, main.indexOf('\nhandle', start + 1));
  };
  const decrypt = handler('interceptor:start');
  assert.match(
    decrypt,
    /if \(decryptHttps\) \{\s+const allowed = await confirmations\.allow\('decrypt-https'/,
  );
  // Decrypting needs domains to limit the CA to, checked here whatever the page sent.
  assert.match(
    decrypt,
    /if \(decryptHttps && !domains\.length\)\s*throw new Error\(\s*'List the domains to decrypt/,
  );
  assert.ok(decrypt.indexOf('!domains.length') < decrypt.indexOf('useInterceptor().start('));
  const trust = handler('interceptor:trustAuthority');
  const asked = trust.indexOf("'trust-authority'");
  assert.ok(asked > 0, 'trusting asks');
  assert.ok(asked < trust.indexOf('runTrustCommands(commands)'), 'before the trust store changes');
});

test('the terminal runs in its own view, which the app window cannot type into', () => {
  const read = (file: string) => readFileSync(path.join(__dirname, '../src', file), 'utf8');
  const main = read('main.ts');
  // Every channel that reaches a shell answers only the terminal's own view.
  for (const channel of ['start', 'shells', 'write', 'resize', 'stop'])
    assert.match(main, new RegExp(`handleTerminal\\(\\s*'terminal:${channel}'`), channel);
  assert.doesNotMatch(main, /\bhandle\(\s*'terminal:(start|shells|write|resize|stop)'/);
  assert.match(
    main,
    /function handleTerminal[\s\S]*?if \(!fromAppWindow\(event, terminalView\?\.webContents\)\)/,
  );
  assert.equal(main.match(/terminals\.start\(/g)?.length, 1);
  // The view is sandboxed, isolated, and in a session of its own, docked over the panel or
  // expanded into a window, but never the app's page itself.
  const open = main.slice(main.indexOf('async function useTerminal'));
  const options = open.slice(
    open.indexOf('new WebContentsView('),
    open.indexOf('terminalView = view'),
  );
  for (const setting of [
    "preload: path.join(__dirname, 'terminal-preload.js')",
    'contextIsolation: true',
    'nodeIntegration: false',
    'sandbox: true',
    'partition: TERMINAL_PARTITION',
  ])
    assert.ok(options.includes(setting), setting);
  // The app window may place the docked terminal, checked in main, and never type into it.
  assert.match(main, /handle\('terminal:dock'[\s\S]*?dockedAt = dockBounds\(scaled/);
  // What the app window may send: a staged command, cleaned in main, never a keystroke.
  assert.match(main, /handle\('terminal:type'[\s\S]*?const command = stagedCommand\(text\)/);
  const appBridge = read('preload.ts');
  assert.doesNotMatch(appBridge, /'terminal:(start|write|resize|stop|shells)'/);
  // The terminal's bridge reaches the terminal's channels and nothing else.
  const terminalBridge = read('terminal-preload.ts');
  const channels = [...terminalBridge.matchAll(/ipcRenderer\.(?:invoke|on)\('([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.ok(channels.length >= 8);
  for (const channel of channels) assert.match(channel, /^terminal:/, channel);
});
