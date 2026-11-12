---
description: Answers to common questions about API Workbench.
icon: help-circle-outline
---

# FAQ

## Is API Workbench free?

Yes. It is open source under the [MIT License](../LICENSE): use it, change it, and ship it, commercially or not.

## Does it need an account or send my data anywhere?

No. There is no account and no cloud sync. Workspaces, history, and credentials stay on your machine, in the app's user data folder. To work with others, you can share a workspace in a folder your team already uses — a network drive, a synced folder, or a Git checkout; secrets stay on each person's device. See [Team workspaces](team-workspaces.md). The app only contacts the APIs you send requests to, the secret stores or OAuth providers you configure, and GitHub to check for new versions. That check sends no workspace data, and you can limit it to when you ask — see [Updates](updates.md#privacy-and-security).

## Where are my secrets stored?

Saved credentials and OAuth tokens are in the [credential vault](credentials.md), encrypted by your operating system: macOS Keychain, Windows DPAPI, or the Linux Secret Service. Values typed into a request's Auth tab or an environment are stored as plain text in the workspace file, so prefer the vault for anything long-lived.

## Can I use my Postman, Insomnia, Bruno, or Hoppscotch collections?

Yes — import collections and environments from Postman (v2.0 and v2.1), Insomnia (v4 and v5), Bruno, and Hoppscotch. OpenCollection, OpenAPI, HAR, cURL, and `.http` files work too. See [Migrate to API Workbench](guides/migrate.md) for a guide for each tool.

## Does it run Postman or JavaScript test scripts?

API Workbench runs its own JavaScript [scripts](scripts.md), before a request is sent and after its response, with the `aw` API — in a sandboxed engine with no access to files, the network, or the vault. Scripts from Postman and other tools use their own APIs and are not imported: rewrite them with `aw`, or as [assertions](tests.md) and [captures](variables.md#capture-values-from-responses), which need no code. Scripts that arrive in an import or a teammate's change are paused until you allow them.

## Can I use it from VS Code or a terminal?

Yes. The [VS Code extension](vscode.md) works on the same workspaces as the app — browse, edit, send, and run requests, use the Testing view and the runner, serve mocks, open live connections, and send `.http` files — with the command line inside it, so it needs nothing else installed. The [command line](cli.md) runs collections and load tests in CI, sends requests, and manages workspaces, environments, credentials, certificates, specifications, and mocks from a terminal. Both are attached to every release.

## Can VS Code or the command line see my secrets?

They never show them. Both open only the API Workbench vault, with its password; secret-looking values are printed as `<hidden>`, and new secrets go in through standard input or an environment variable, never an argument. Credentials the app keeps in the system's credential store open only in the app — see [Use your credentials in VS Code and the command line](credentials.md#use-your-credentials-in-vs-code-and-the-command-line).

## Which protocols are supported?

HTTP/1.1 and HTTP/2 (REST, GraphQL, SOAP), WebSocket, Server-Sent Events, NDJSON streams, gRPC with every kind of streaming, Socket.IO, and MQTT 3.1.1 and 5. See [Protocols](live-protocols.md).

## Can I use it in a browser?

The app is a desktop app. `npm run preview` serves the interface in a browser for development, but browsers apply CORS and there is no vault, OAuth, proxy, or Interceptor there.

## Can teams share collections?

Share collections by exporting them — as API Workbench JSON, Postman, Bruno, or OpenCollection — and committing them to a repository. Real-time collaboration and cloud workspaces are not part of API Workbench.

## How do I move to a new computer?

Export each workspace's collections and environments, and import them on the new machine. Credentials are never exported, so recreate them there — the vault is encrypted for your account on your machine.

## How do I update?

Installed copies check for new versions and ask before downloading one. Click the version number in the status bar to check now, or choose how updates arrive in **Settings → Updates**. The portable Windows `.exe` and `.zip`, and the Linux `.tar.gz`, are updated by downloading the new version. See [Updates](updates.md).

## How do I report a bug or a security issue?

Open an [issue](https://github.com/techieutils/api-workbench/issues) for bugs and ideas. Report security vulnerabilities privately as described in the [security policy](../SECURITY.md).
