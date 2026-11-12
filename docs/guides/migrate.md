---
description: Move collections, environments, and auth from Postman, Insomnia, Bruno, Hoppscotch, and other API clients.
navTitle: Overview
icon: transit-connection-variant
---

# Migrate to API Workbench

API Workbench imports collections and environments from the tools teams use most, so you can switch without rebuilding requests by hand. Every import is previewed first and applied only if the whole input is valid, so trying one is safe.

```cards
- title: Migrate from Postman
  icon: swap-vertical
  href: migrate-from-postman.md
  text: Collection v2.0 and v2.1 exports, with folders, auth, and environments.
- title: Migrate from Insomnia
  icon: weather-night
  href: migrate-from-insomnia.md
  text: v4 JSON and v5 YAML exports, with folders and sub-environments.
- title: Migrate from Bruno
  icon: dog
  href: migrate-from-bruno.md
  text: A collection folder, a ZIP, or Bruno's collection JSON.
- title: Migrate from Hoppscotch
  icon: web
  href: migrate-from-hoppscotch.md
  text: REST and GraphQL collection exports and environment exports.
- title: More tools
  icon: toolbox-outline
  href: migrate-from-other-tools.md
  text: Thunder Client, REST Client, JetBrains HTTP Client, OpenAPI, SoapUI, HAR, and cURL.
```

## What comes across

|                         | Postman      | Insomnia     | Bruno             | Hoppscotch   |
| ----------------------- | ------------ | ------------ | ----------------- | ------------ |
| Folders                 | ✓            | ✓            | ✓                 | ✓            |
| Params, headers, bodies | ✓            | ✓            | ✓                 | ✓            |
| GraphQL                 | ✓            | ✓            | ✓                 | ✓            |
| WebSocket               | —            | ✓            | ✓                 | —            |
| gRPC                    | —            | Skipped      | ✓, load the proto | —            |
| Inherited auth          | ✓            | ✓            | ✓                 | ✓            |
| Inherited headers       | —            | Not imported | ✓                 | ✓            |
| Environments            | ✓            | ✓            | ✓                 | ✓            |
| Collection variables    | ✓            | —            | Not imported      | ✓            |
| Scripts and tests       | Not imported | Not imported | Not imported      | Not imported |

A dash means the source tool doesn't export it. Collection variables arrive as an environment named after the collection.

Auth types carry over where API Workbench has an equivalent: Basic, Bearer, Digest, API key, AWS Signature, OAuth 1.0, OAuth 2.0, and JWT. Anything else, such as NTLM or Hawk, is reported in the preview so you can set it up again.

## Before you switch

1. **Export everything you need.** That means collections and environments, which several tools export separately.
2. **Import into a new workspace** to keep the migration apart from existing work. See [Workspaces](../workspaces.md).
3. **Read the preview notes.** They list every script, auth type, and value that could not be converted.
4. **Secure secrets.** Imported tokens and passwords arrive as plain text. Move long-lived ones into the [credential vault](../credentials.md) and select them with **Saved credential**.
5. **Recreate tests** as [assertions](../tests.md) and pass values between requests with [captures](../variables.md#capture-values-from-responses). Each guide shows typical conversions.
6. **Run the collection** in the [Runner](../runner.md) to confirm everything works.

> [!TIP]
> Need to keep working with teammates who stay on another tool? API Workbench exports to Postman, Insomnia, Bruno, OpenCollection, OpenAPI, HAR, and more. See [Import and export](../import-export.md).
