---
description: Present client certificates for mutual TLS, stored in the encrypted vault.
icon: certificate-outline
---

# Client certificates

For APIs that require mutual TLS, add a client certificate in **Credentials → Add credential → Client certificate**:

1. Enter the host it is for — `api.example.com` or a wildcard such as `*.example.com` — and optionally a port.
2. Choose a PEM certificate and private key, or a PFX/P12 bundle, and its passphrase if it has one.
3. Save. The app checks that the key matches the certificate and copies everything into the vault; the files are not read again.

The certificate is then presented automatically to matching hosts over HTTPS, `wss://`, HTTPS streams, and TLS gRPC. The most specific match wins. Turn a certificate on or off from its switch in Credentials or **Settings → Certificates**. As with other credentials, the vault must be unlocked to send it.

CA certificates you trust — for example, for an internal API — are public, so they are kept in **Settings → Certificates** and HTTP settings rather than in the vault.

## In VS Code and the command line

The VS Code extension's **Open Certificates** page and the command line's `certificate` commands add, switch, and remove client certificates and trusted CAs too, keeping them in the [API Workbench vault](credentials.md#the-api-workbench-vault). Requests sent or run there over HTTPS present the matching certificate; live connections present client certificates only in the app. See [Certificates in VS Code](vscode.md#certificates) and [Client certificates on the command line](cli.md#client-certificates).

## Trusted CA certificates

To trust an internal certificate authority, add its CA certificate in **Settings → Certificates** with **Add CA file**, or paste a PEM bundle into the HTTP settings' CA field for a workspace, collection, or request. See [Settings](settings.md#http-settings).
