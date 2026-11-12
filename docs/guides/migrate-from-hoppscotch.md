---
description: Bring Hoppscotch REST and GraphQL collections and environments into API Workbench.
icon: web
---

# Migrate from Hoppscotch

## 1. Export from Hoppscotch

Hoppscotch exports collections and environments separately, so export both.

1. **REST collections:** in **Collections**, open a collection's **⋯** menu and choose **Export**. To export all of them at once, use the import and export button at the top of the panel and choose **Export as JSON**.
2. **GraphQL collections:** do the same on the **GraphQL** page.
3. **Environments:** in **Environments**, use the import and export button and choose **Export as JSON**.

Hoppscotch Desktop, the web app, and self-hosted instances export the same format.

## 2. Import

1. In API Workbench, click **Import** in the explorer.
2. Choose the exported files — several at once, or a ZIP of them.
3. Check the preview: it lists the requests and environments it found, with a note for anything that could not be converted.
4. Click **Import into workspace**. Nothing changes unless the whole import is valid.

## 3. What comes across

| Hoppscotch                               | In API Workbench                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collections and folders                  | Collections, nested by path                                                                                                                                      |
| Requests, params, headers, bodies        | Requests, including JSON, XML, text, multipart, urlencoded, and binary bodies; disabled rows stay disabled. Choose files for file fields and binary bodies again |
| GraphQL requests                         | POST requests with a GraphQL JSON body                                                                                                                           |
| Collection and folder auth (**Inherit**) | Inherited by the requests inside                                                                                                                                 |
| Collection and folder headers            | Added to the requests inside, with inner folders overriding outer ones                                                                                           |
| Collection variables                     | An environment named after the collection                                                                                                                        |
| Environments                             | One environment each                                                                                                                                             |
| `<<variable>>`                           | `{{variable}}`                                                                                                                                                   |
| Secret environment variables             | **Empty** — Hoppscotch doesn't export secret values                                                                                                              |
| Request variables                        | **Not imported** — add them to an environment                                                                                                                    |
| Pre-request and test scripts             | **Not imported** — rewrite tests as [assertions](../tests.md) or [scripts](../scripts.md) with the `aw` API                                                      |

Auth types Basic, Bearer, Digest, API key, AWS Signature, OAuth 2.0, and JWT carry over. Hawk and Akamai EdgeGrid are reported in the preview so you can set them up again.

> [!WARNING]
> Imported tokens and passwords arrive as plain text in auth fields and environment values. Move long-lived ones into the [credential vault](../credentials.md) and use **Saved credential**.

## 4. Recreate tests

A Hoppscotch test script and its API Workbench equivalent:

```javascript title="Hoppscotch"
pw.test('ok', () => pw.expect(pw.response.status).toBe(200));
pw.test('has id', () => pw.expect(pw.response.body.id).toBeType('number'));
pw.env.set('user_id', pw.response.body.id);
```

```text title="API Workbench"
status 200
json-type $.id number
```

The `pw.env.set()` line becomes a capture in the request's **Vars** tab: variable `user_id`, source `$.id`. See [Capture values from responses](../variables.md#capture-values-from-responses).

## 5. Share with Hoppscotch users

API Workbench can't write the Hoppscotch format, but Hoppscotch imports Postman and OpenAPI, which API Workbench exports. See [Import and export](../import-export.md).
