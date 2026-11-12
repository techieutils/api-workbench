# Security policy

API Workbench stores credentials, tokens, and certificates, and renders responses from servers you do not control, so security reports are taken seriously. This policy explains which versions are supported, how to report a vulnerability, what happens next, and how the app protects your data.

## Contents

- [Supported versions](#supported-versions)
- [Reporting a vulnerability](#reporting-a-vulnerability)
- [What happens next](#what-happens-next)
- [Safe harbour](#safe-harbour)
- [What is in scope](#what-is-in-scope)
- [Security design](#security-design)
- [Keeping your installation secure](#keeping-your-installation-secure)

## Supported versions

| Version                       | Security fixes    |
| ----------------------------- | ----------------- |
| The latest release            | Yes               |
| Earlier releases              | No — update first |
| Unreleased builds from `main` | Best effort       |

The command line is released with the app and shares its version, so the same rules apply to the `@techieutils/api-workbench-cli` npm package and the `api-workbench-cli.cjs` release file. Please update to the latest release before reporting, in case the issue is already fixed.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a vulnerability.** Report it privately through GitHub:

1. Open a [new private security advisory](https://github.com/techieutils/api-workbench/security/advisories/new) (or the repository's **Security** tab → **Report a vulnerability**).
2. Include:
   - what an attacker can do, and what they need first (a malicious server, an imported file, local access);
   - steps or a minimal file to reproduce it;
   - the affected version and platform;
   - your assessment of severity, and any suggested fix.

Use made-up values in reports — never real secrets, tokens, or other people's data. Reports in English are easiest to act on, but write in whatever language you are comfortable with.

There is no bug bounty; reporters are credited instead.

## What happens next

| Step               | Target                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Acknowledgement    | Within 3 business days                                                                       |
| Initial assessment | Within 10 business days: whether it is accepted, and its severity                            |
| Fix                | Critical and high: as fast as possible, aiming for 30 days. Others: the next planned release |
| Disclosure         | Coordinated with you, no later than 90 days after the report unless agreed otherwise         |

These are targets for a volunteer-run project, not guarantees; you will be kept informed if a fix takes longer. Severity follows [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document).

Once a fix is released, a GitHub security advisory is published (with a CVE when it qualifies), the release notes and [changelog](docs/changelog.md) describe it, and you are credited unless you prefer otherwise.

## Safe harbour

Research done in good faith under this policy is welcome. We will not pursue or support legal action against you for it, as long as you:

- test only against your own installations, data, and accounts;
- do not access, change, or delete other people's data, or degrade services for others;
- report the issue privately and give us reasonable time to fix it before disclosure.

If in doubt about whether something is allowed, ask in a private advisory first.

## What is in scope

- Secrets, tokens, or private keys leaving the main process, being written unencrypted, or appearing in logs, the request console, History, exports, generated code, or the renderer.
- Credentials being sent to an origin other than the one they are restricted to, or across redirects.
- Code running from an imported collection, a response, a preview, or another untrusted source — including through the test assertion or capture languages, which are parsed, never evaluated.
- A response preview escaping its sandbox: running script, navigating the app, or loading remote content.
- The Interceptor accepting connections from other machines, or its certificate authority key being exposed.
- Bypassing the renderer's content security policy, context isolation, or sandbox.
- The updater installing a file that did not come from a published release of this repository, or that fails its checksum.
- The command line's npm package containing anything other than the release's attested `api-workbench-cli.cjs`, or being published from anywhere but this repository's release workflow.
- The command line printing a secret, taking one as an argument, or writing one to a report.
- The script editor running any part of a script while it suggests code or checks syntax.
- The VS Code extension running in an untrusted workspace, running a program or scripts a workspace chose, or showing a secret.

**Out of scope:** problems that need an attacker to already control your user account or machine; denial of service from a server you chose to call (a huge or slow response); the strength of TLS settings you chose to relax, such as turning off certificate verification; and findings in third-party dependencies with no demonstrated effect on API Workbench — please report those upstream.

## Security design

- **Encrypted vault.** Credentials, the Interceptor's certificate authority key, and certificate passphrases are encrypted with Electron's asynchronous `safeStorage` (macOS Keychain, Windows DPAPI, or the Linux Secret Service). Nothing is stored when OS encryption is unavailable, and the vault and the certificate authority key are re-encrypted when the OS reports a rotated key.
- **Secrets stay in the main process.** The renderer only receives metadata; requests are signed and sent from the main process.
- **One way in.** The main process answers IPC only from the app window's top frame — not other windows or frames inside the page — through a single guard that a lint rule makes every handler use. In the desktop app the page cannot open network connections at all (`connect-src 'none'`): every request goes through the main process.
- **A locked-down renderer.** Context isolation, sandboxing, and a strict content security policy: only the app's own scripts and styles, no inline code or `eval`, no plugins, forms, or `<base>` rewriting, and no remote content. Every web content the app creates refuses pop-ups, navigation, and `<webview>`, and every permission is refused except the clipboard for the app's own window.
- **No commands from content.** The interface cannot run system programs: the main process starts only the shells it found itself for the terminal, and fixed tools (`security`, `certutil`) to trust the Interceptor's certificate, never with a shell. A command the app puts in the terminal is typed without control characters, so it cannot run itself — you press Enter — and its values are shell-quoted. The terminal is a page of its own (an Electron view drawn over the dev tools panel, or in its own window), the only one whose IPC reaches a shell, with its own minimal bridge and session; the app's window can only place it, or stage a command at a new terminal's prompt, which the main process strips of control characters so it never runs by itself. Starting HTTPS decryption and trusting the Interceptor's certificate are each confirmed in a native dialog shown by the main process, which script in the window cannot answer. The Interceptor's certificate authority lasts 30 days and is renewed as it runs out, so a copied key stops working soon after; it carries X.509 name constraints for the **Domains to decrypt**, which decryption requires, so it can vouch only for those domains and this computer. Packaged builds cannot be run as plain Node.js.
- **Previews cannot run code.** HTML renders in a sandboxed frame without scripts. When the preview offers capture, the frame is same-origin so the app can read its elements, but scripts stay disabled and the content security policy still blocks remote loads and navigation. Markdown is escaped before it is shown, and links open only after you confirm the address.
- **Untrusted text is parsed, not run.** Imports never execute code or fetch remote references; assertions and captures are a fixed language, and HTML captures use a parser that does not run scripts. Regular expressions from a workspace, a collection, a mock, or a specification (tests, `regex` captures, mock rules and path parameters, JSON Schema `pattern`s) are refused when their shape could take exponential time to match, so a shared one cannot freeze the app or a mock server.
- **Request scripts are sandboxed and opt-in.** A request's own JavaScript runs in QuickJS, a separate engine compiled to WebAssembly, in a process of its own, with no access to files, the network, other processes, or the vault, and with time and memory limits. Scripts that arrive in an import, a teammate's change, or an edit to the workspace's files run only after you allow their collection; the allow list is kept outside every workspace.
- **The script editor only reads scripts.** Its suggestions come from a fixed description of the `aw` API and from the last response's parsed JSON, and its syntax check parses the text with [acorn](https://github.com/acornjs/acorn); neither runs any of it, in the interface or anywhere else. A paused script is checked the same way, without running.
- **Verified updates.** Updates come only from this repository's GitHub releases over HTTPS, and each download is checked against the SHA-512 checksum in the release's `latest*.yml` before it installs; on macOS the update must also be signed by the same developer as the installed app. You choose whether updates download on their own, after you confirm, or only when you check.
- **A cautious VS Code extension.** The extension runs only in workspaces you trust, and only through the bundled command line, so it follows the same rules: secrets stay hidden, scripts run only after you allow them, and saved credentials never leave the app. A workspace's settings cannot choose the program it runs or turn scripts on; only your user settings can. Auth set in its request editor — every type the app has — never shows a saved token, password, or other secret; new ones go to the command line in its environment, and a form's fields on its standard input, never as arguments. OAuth 2.0 tokens are got by the command line (`request token`), which keeps them in the request and prints only when they expire; a browser sign-in uses PKCE and a callback on 127.0.0.1, and VS Code opens the sign-in page only if it is a web address. A GraphQL schema is fetched by the command line (`request schema`), with the request's own auth and no scripts; the extension checks it and shows its names and descriptions as text only. Credentials added or changed on its Credentials page go to the vault through the command line's environment as JSON (`secret set --fields-from-env`), never as arguments, and are never sent back: the page sees only whether each secret is saved. A team folder never holds a secret value: an auth secret set from the command line or VS Code is kept with the app's own data for the folder when the app on this computer has it open, and refused otherwise. Scripts edited there are only parsed, for suggestions and syntax errors, and saving one never runs it; the app treats an edited script as new, so it waits for **Allow scripts**. Credentials can be moved from the system's credential store into the API Workbench vault (**Use the API Workbench vault…**), in the main process, re-encrypted and written atomically, so the command line and VS Code can read them with its password; VS Code may remember that password in its secret storage, backed by the system keychain, only when you choose. A request's saved credential — sent, run, or connected live — is read by the command line from the vault, applied only to the origin it is for, and never printed or reported — for a team folder, only when the app on this computer has it open, with each request's credential choice kept in the app's own data for it, never in the shared folder — with the password typed in VS Code given only to that connection's environment. By default (`apiWorkbench.engine` is `builtIn`, a user setting) the same command-line code runs inside VS Code's extension host, loaded from the extension itself and never from a workspace; `commandLine` runs it as a process of its own instead. Request scripts still run only in its QuickJS sandbox. Client certificates added on its Certificates page are read from files chosen in VS Code's own file dialog, checked with a passphrase typed in a hidden box, and kept in the vault by the command line, which gets the passphrase in its environment; keys and passphrases are never shown or printed. Files a request uploads are chosen the same way, or named by a `.http` file (`< ./path`), and read by the command line when the request is sent; a page never names a path. The first send or live connection from a `.http` file or a team folder to a new host asks, after its variables are filled in (`apiWorkbench.confirmNewHosts`, user settings only); the command line enforces the list with `--allow-host`. A file a `.http` file names must be inside that file's project (its repository, or its own folder outside one), after links are followed, so a repository cannot make a send upload your keys or other files from elsewhere on your computer. Its tools for language models (Copilot's agent mode) work the same way: VS Code asks you before each send or run, a model's send never saves into the workspace, saved credentials apply only while you have the vault unlocked and only if your user settings allow it (`apiWorkbench.toolsUseSavedCredentials`, which a workspace cannot set; the confirmation says which, and neither the password nor the secret is given to the model), scripts run only if you allowed them for good in your user settings, and a model sees only what the command line prints, with secret-looking values hidden. It is attached to each release with the other files, under `SHA256SUMS` and its attestation.
- **A traceable command line.** The command line is one bundled file with no dependencies to install. Each release attaches it with a SHA-256 checksum and a signed build-provenance attestation. The npm package is published to GitHub Packages only after the release is reviewed and published, by this repository's workflow, and only when its file is byte-for-byte the attested release file. It never prints secrets or takes them as arguments: they come from standard input or environment variables.
- **Private by default.** No account, analytics, or telemetry. The update check requests only release information and sends no workspace data. History keeps responses, console lines, and failures for the session; they are written to disk only while **Persist response bodies** is on. Console lines are metadata only and redact query values.
- **Checked on every change.** CI fails on a high or critical advisory in shipped dependencies (`npm audit`), CodeQL scans the code on each pull request and weekly, gitleaks scans the whole git history for committed secrets, and Dependabot proposes dependency and workflow updates every week. Every push also fuzzes the parsers that read other people's text — importers, `.http` and cURL files, specifications, assertions, response bodies, and regular expressions — and fails on a crash, hang, memory blow-up, or changed prototype (`npm run test:fuzz`).
- **Request integrity.** Body integrity headers are computed over the exact bytes sent, before any request signing, so signatures cover them.

## Keeping your installation secure

- Keep updates on (**Settings → Updates**), or install new versions when they are released; only the latest version gets security fixes.
- Keep long-lived secrets in the [credential vault](docs/credentials.md), not in environment variables, which are saved as plain text.
- Leave **Verify SSL/TLS certificates** on except for local test servers, and prefer a custom CA bundle to turning verification off.
- Turn on **Persist response bodies** only if you need responses after a restart, since they may contain personal or sensitive data.
- Trust the Interceptor's certificate authority only on machines you use for testing, and remove it when you are done.
- To install the command line from GitHub Packages, use a token with only the `read:packages` scope, and give it to npm through an environment variable (`_authToken=${GITHUB_TOKEN}` in `.npmrc`) rather than writing it into the file. In CI, pin a version, and keep secrets in your CI system's secret store, passed with `--var name`.
