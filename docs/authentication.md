---
description: Authorize requests with Bearer, Basic, API keys, Digest, NTLM, WSSE, AWS Signature, Akamai EdgeGrid, Hawk, JWT, OAuth 1.0, and OAuth 2.0.
icon: key-variant
---

# Authorization

Choose how each request authenticates in its **Auth** tab, and set a default for a whole collection.

## Authentication types

Pick a type in a request's **Auth** tab. The **This request / Collection** switch edits either the request's own authentication or the default for its collection, which requests set to **Inherit from collection** use.

| Type                        | What it does                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **None**                    | Sends no authorization.                                                                                                                                                                       |
| **Inherit from collection** | Uses the collection's default.                                                                                                                                                                |
| **Bearer token**            | Sends `Authorization: Bearer <token>`.                                                                                                                                                        |
| **API key**                 | Sends a key as a header or a query parameter.                                                                                                                                                 |
| **JWT bearer**              | Signs a JSON Web Token locally and reuses it until shortly before it expires (10% of its lifetime early, at most 30 seconds). Changing the key, header, payload, or lifetime signs a new one. |
| **OAuth 2.0 (request)**     | Gets an access token for this request and renews it automatically when it can.                                                                                                                |
| **Basic auth**              | Sends a Base64-encoded username and password.                                                                                                                                                 |
| **Digest auth**             | Answers the server's Digest challenge (MD5 or SHA-256, including `-sess`).                                                                                                                    |
| **AWS Signature**           | Signs the request with AWS Signature Version 4.                                                                                                                                               |
| **OAuth 1.0**               | Signs the request with OAuth 1.0a (HMAC-SHA1, HMAC-SHA256, or PLAINTEXT).                                                                                                                     |
| **NTLM**                    | Negotiates Windows NTLMv2 authentication. Enter the username (or `DOMAIN\user`), password, and optionally domain and workstation.                                                             |
| **WSSE**                    | Sends a WSSE UsernameToken: an `X-WSSE` header with a SHA-1 password digest, a nonce, and a timestamp.                                                                                        |
| **Akamai EdgeGrid**         | Signs the request with `EG1-HMAC-SHA256` from the client token, client secret, and access token.                                                                                              |
| **Hawk**                    | Signs the request with a Hawk MAC (SHA-256 or SHA-1), optionally with a payload hash, `ext`, `app`, and `dlg`.                                                                                |
| **Saved credential**        | Uses a profile from the encrypted credential vault.                                                                                                                                           |

Fields accept `{{variables}}`, so a token can come from the active environment.

> [!WARNING]
> Secrets typed into the Auth tab are stored as plain text in the workspace file, as the tab reminds you. Use **Saved credential** for anything long-lived — see [Credential vault](credentials.md).

## Signed and negotiated types

Digest, NTLM, WSSE, AWS Signature, Akamai EdgeGrid, Hawk, JWT bearer, and OAuth 1.0 are computed by the desktop app when the request is sent, from the final method, URL, and body, so each redirect hop is signed again. Generated code leaves the signature out.

- **NTLM** sends a negotiate message, reads the server's challenge from the `401` response, and answers it on the same connection. Keep **Keep-alive** on in [HTTP settings](settings.md) so the connection is reused. NTLM works with HTTP requests only, not WebSocket, SSE, NDJSON, or gRPC.
- **Akamai EdgeGrid** signs any headers you list under **Headers to sign**, and hashes the first **Max body size** bytes of a `POST` body (131072 by default).
- **Hawk** covers the body and its content type only when **Include a payload hash** is checked.

## OAuth 2.0

Create an **OAuth 2.0** profile in Credentials, then **Connect** to get a token.

### Discover the settings

Rather than typing endpoints, enter a URL under **Discover settings** and click **Discover**. It accepts:

- **The API's URL**, such as `https://mcp.example.com/mcp`. The API's protected resource metadata (`/.well-known/oauth-protected-resource`, RFC 9728) names its authorization server — or, if it only answers `401`, the `resource_metadata` in its `WWW-Authenticate` challenge does.
- **The authorization server (issuer)**, such as `https://login.example.com`. Its `/.well-known/oauth-authorization-server` (RFC 8414) or `/.well-known/openid-configuration` (OpenID Connect) is read.
- **A `/.well-known/` URL** directly.

Discovery fills the authorization and token URLs and the **Resource**, adds the scopes the API lists when none are set, and changes the grant or client authentication only if the server does not support your choice. It reports what it filled, which server it used, and anything to check, such as missing PKCE support. Everything stays editable.

> [!IMPORTANT]
> To protect you, every document must come over HTTPS (HTTP only on localhost), redirects are not followed, and each document must name the identifier it was fetched for — so an API cannot send you to a lookalike sign-in server. Endpoints that are not HTTPS are left out with a warning.

### Resource indicator

Audience, Resource, and the callback port are under **Advanced**, which opens on its own when any of them is set. **Resource** (RFC 8707) is the API the token is for, such as `https://api.example.com`. It is sent when signing in, getting, and refreshing tokens, so servers that support it — including MCP servers — issue a token limited to that API.

### Grants and tokens

- **Authorization code with PKCE** opens your system browser to sign in, and receives the result on a local callback, `http://127.0.0.1:43821/oauth/callback` by default. Register that redirect URI with your provider, or change the port in the profile.
- **Client credentials** for service accounts, with the client secret sent by HTTP Basic or in the form body.
- Scopes and audience are supported. Use **Refresh** when the provider issued a refresh token, or **Reconnect** for a new token. **Disconnect** removes the saved tokens locally; it does not revoke them at the provider.

For a one-off request, the **OAuth 2.0 (request)** type gets and renews a token for that request alone.
