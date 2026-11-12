---
description: Bring Postman collections and environments into API Workbench, and secure their secrets.
icon: swap-vertical
---

# Migrate from Postman

Coming from another tool? See [Migrate to API Workbench](migrate.md).

## 1. Export from Postman

1. In Postman, open a collection's **⋯** menu, choose **Export**, and pick **Collection v2.1**.
2. Export each environment you need from **Environments** the same way.

## 2. Import

1. In API Workbench, click **Import** in the explorer.
2. Choose the exported files — several at once, or a ZIP of them.
3. Check the preview: it lists the requests and environments it found, with a note for anything that could not be converted.
4. Click **Import into workspace**. Nothing changes unless the whole import is valid.

## 3. What comes across

| Postman                           | In API Workbench                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folders                           | Collections                                                                                                                                                                       |
| Requests, params, headers, bodies | Requests, including raw, GraphQL, form-data, and urlencoded bodies                                                                                                                |
| Collection and folder auth        | Collection authorization, inherited by requests                                                                                                                                   |
| Environments and variables        | Environments with the same `{{variables}}`                                                                                                                                        |
| Pre-request and test scripts      | **Not imported** — rewrite tests as [assertions](../tests.md) or [scripts](../scripts.md) with the `aw` API and captures as [Vars](../variables.md#capture-values-from-responses) |

> [!WARNING]
> Imported tokens and passwords arrive as plain text in auth fields and environment values. Move long-lived ones into the [credential vault](../credentials.md) and use **Saved credential**.

## 4. Recreate tests

A typical Postman test and its API Workbench equivalent:

```javascript
pm.test('ok', () => pm.response.to.have.status(200));
pm.test('has id', () => pm.expect(pm.response.json().id).to.exist);
```

```text
status 200
json-exists $.id
```

## 5. Go both ways

API Workbench exports to Postman v2.1 too — see [Import and export](../import-export.md) — so teammates who stay on Postman can still use your collections.
