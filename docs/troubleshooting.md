---
description: Fix vault and keychain problems, certificate errors, proxy ports, live connection issues, and failed update checks.
icon: wrench-outline
---

# Troubleshooting

## The credential vault

**“The credential vault is locked.”**
The vault opens the first time you visit **Credentials** in each session. Click **Unlock vault** in the error (it can resend the request, reconnect, or rerun for you), or open **Credentials**.

**“Your system keychain may have denied access.”**
You declined the system's prompt, or the keychain refused. Click **Try again** and allow access. On macOS, you can check API Workbench's entry in Keychain Access.

**“OS-backed encryption is unavailable.”**
Your system keychain is locked or not reachable. Unlock it, then click **Restart app** — your workspace is saved first. No secret is ever saved as plain text instead.

<a id="linux-no-keyring"></a>
**“No system keyring is available to encrypt secrets.” (Linux)**
No Secret Service is running, so there is nowhere safe to keep the key. Install and start GNOME Keyring or KWallet (most desktop environments start one automatically), then restart API Workbench. Minimal window managers and headless sessions often need one started by hand.

**A saved credential is not sent.**
Profiles are only sent to their **Allowed API origin** — the exact scheme, host, and port. `https://api.example.com` does not match `https://api.example.com:8443` or `http://api.example.com`.

**A credential stopped working after moving computers.**
The vault is encrypted for your user account on your machine, and credentials are never exported. Recreate them on the new machine.

## Requests

**“Cross-origin redirect blocked.”**
Redirects to a different origin are never followed, so credentials and bodies are not sent somewhere unexpected. Request the new URL directly.

**A variable is not replaced.**
The bar under the URL lists unresolved variables. Check the spelling, that the variable is enabled, and which environment is active.

**Certificate errors with an internal API.**
Add your organization's CA certificate in **Settings → Certificates** or in the HTTP settings' CA bundle. Turning off verification is possible per request, collection, or workspace, but is best kept for local development.

**The browser preview cannot send a request.**
`npm run preview` runs the interface in a browser, where CORS applies and there is no vault, OAuth, proxy, or Interceptor. Use the desktop app.

## Interceptor

**“Port 8899 is already in use.”**
Another program has the port. Choose a different **Port** and start again, then update the app's proxy setting to match.

**An app's HTTPS requests fail, or appear as errors saying the client did not accept the certificate.**
The app does not trust the Interceptor certificate. Use **Trust certificate**, or **Save certificate…** and add it to the app's own trust store (Firefox, Node.js, Java, and many CLIs keep their own). Restart browsers that were already open. Alternatively, turn off **Decrypt HTTPS** to pass HTTPS through without reading it.

**Nothing appears in the list.**
Check that the app is using `127.0.0.1` and the port shown, for both HTTP and HTTPS, and that **Record** is on. Some apps ignore system proxy settings and need their own.

**“HTTPS cannot be decrypted.”**
The certificate's key is protected by OS encryption, which is unavailable. See _OS-backed encryption is unavailable_ above. HTTP capture and HTTPS tunnels keep working.

## Live protocols

**A WebSocket or stream disconnects.**
The default session timeout is five minutes; raise it (up to an hour) in the request's **Settings**. SSE streams do not reconnect automatically — click **Connect** again.

**gRPC cannot find a method.**
The `.proto` must be self-contained: imports of other files and server reflection are not supported. Paste the full definition and click **Discover methods**.

## Updates

**A check fails with "Could not reach GitHub".** The app needs HTTPS access to `github.com`; check your connection, VPN, or firewall. Update checks use the operating system's network settings, not the proxy in **Settings → Requests**.

**Settings → Updates says this copy cannot update itself.** The portable Windows `.exe` and `.zip`, the Linux `.tar.gz`, and copies run from source are updated by downloading the new version. See [Which copies update themselves](updates.md#which-copies-update-themselves), and [Updates](updates.md#troubleshooting) for every message.

## Building from source

**`npm test` or the app fails with `Cannot read properties of undefined (reading 'bind')` in `undici`.** Your Node.js is older than 22.19, which the HTTP client needs. Install Node 24 — run `nvm use` in the project folder if you use nvm, since `.nvmrc` names it — and try again.

**`npm install` fails with `EACCES` in the npm cache.** Files in `~/.npm` belong to another user, usually from an earlier `sudo npm`. Give them back to yourself with `sudo chown -R $(id -u):$(id -g) ~/.npm`.

**UI tests fail on one check that passes when run again.** The test window is hidden and can paint late; run the part again with `npm run test:ui -- --only=<number>`. If it keeps failing, open an issue with the output.

## Where data is stored

API Workbench keeps everything in Electron's user data folder. Installed builds use the `API Workbench` folder below; when run from source with `npm start`, the folder is named `api-workbench` instead.

| Platform | Folder                                        |
| -------- | --------------------------------------------- |
| macOS    | `~/Library/Application Support/API Workbench` |
| Windows  | `%APPDATA%\API Workbench`                     |
| Linux    | `~/.config/API Workbench`                     |

Each workspace has a `workspace.json`, an encrypted `credentials.enc`, and a `collections` folder with a YAML file per request; `workspaces.json` lists the workspaces. A workspace saved by an earlier version is kept as `workspace.legacy.json` the first time it is moved into collection files. The Interceptor's certificate is in the `interceptor` folder.

## Still stuck?

Open **Console** in [Dev tools](dev-tools.md) (<kbd>⌘/Ctrl</kbd>+<kbd>J</kbd>) to see each request's log and errors, **Network** for every request's status and timing, and the response's **Timeline** tab to see where a slow or failing request spent its time.
