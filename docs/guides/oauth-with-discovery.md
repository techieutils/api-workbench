---
description: Discover an API's OAuth 2.0 settings from its metadata, sign in, and keep tokens in the encrypted vault.
icon: key-variant
---

# Connect to an OAuth 2.0 API

APIs that publish OAuth metadata — including most identity providers and MCP servers — can be set up from just a URL.

## 1. Create an OAuth 2.0 profile

1. Open **Credentials** and click **Add credential**.
2. Name it, choose **OAuth 2.0**, and set **Allowed API origin** to the API's origin, for example `https://api.example.com`.

## 2. Discover the settings

1. Under **Discover settings**, enter the API's URL (or the authorization server's), and click **Discover**.
2. Discovery fills the authorization and token URLs, the **Resource**, and the scopes the API lists, and reports which server it used and anything to check.

> [!IMPORTANT]
> Discovery only accepts HTTPS metadata (HTTP on localhost), does not follow redirects, and checks that each document names the server it was fetched from — so an API cannot point you at a lookalike sign-in page.

## 3. Register the client

Enter the **Client ID** (and **Client secret** if your client has one) from your provider. For **Authorization code + PKCE**, register this redirect URI with the provider:

```text
http://127.0.0.1:43821/oauth/callback
```

Change the port under **Advanced** if it is taken.

## 4. Connect

Save the profile and click **Connect**. Sign in in your browser; the token is stored in the encrypted vault. **Refresh** renews it when the provider issued a refresh token.

## 5. Use it

In a request's **Auth** tab, choose **Saved credential** and pick the profile. The token is sent only to the allowed origin, and never appears in exports or generated code.

> [!TIP]
> For a quick one-off, the **OAuth 2.0 (request)** auth type has the same **Discover settings** panel and keeps the token with that request.

See [Authorization](../authentication.md#oauth-20) for every option.
