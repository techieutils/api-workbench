---
description: Bring a Bruno collection folder, its environments, and its defaults into API Workbench.
icon: dog
---

# Migrate from Bruno

Bruno keeps each collection as a folder of `.bru` files, so there's usually nothing to export: import the folder itself.

## 1. Find the collection

Choose one of these:

- **The collection folder** — the folder that holds `bruno.json`. In Bruno, right-click the collection and choose **Show in Folder** to find it.
- **A ZIP** of that folder.
- **A Bruno collection JSON** — right-click the collection, choose **Share** or **Export**, and pick **Bruno Collection**.

## 2. Import

1. In API Workbench, click **Import** in the explorer.
2. Click **Choose folder** and select the collection folder — or **Choose files** for a ZIP or JSON export.
3. Check the preview: it lists the requests and environments it found, with a note for anything that could not be converted.
4. Click **Import into workspace**. Nothing changes unless the whole import is valid.

## 3. What comes across

| Bruno                                                   | In API Workbench                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Folders                                                 | Collections, nested by path                                                                                |
| `.bru` requests, query and path params, headers, bodies | Requests, including JSON, text, XML, GraphQL, multipart, urlencoded, and file bodies                       |
| `collection.bru` and `folder.bru` headers and auth      | Merged into the requests inside, with inner folders overriding outer ones                                  |
| `environments/*.bru`                                    | One environment each                                                                                       |
| WebSocket requests                                      | WebSocket requests                                                                                         |
| gRPC requests                                           | gRPC requests — load the proto before sending. See [gRPC](../grpc.md)                                      |
| Secret environment variables                            | **Empty** — Bruno keeps secret values on your machine, not in the collection                               |
| Collection and folder variables                         | **Not imported** — add them to an environment                                                              |
| Scripts, tests, and `assert` blocks                     | **Not imported** — rewrite them as [assertions](../tests.md) or [scripts](../scripts.md) with the `aw` API |

> [!WARNING]
> Imported tokens and passwords arrive as plain text in auth fields and environment values. Move long-lived ones into the [credential vault](../credentials.md) and use **Saved credential**.

## 4. Recreate tests

Bruno's `assert` block and its API Workbench equivalent:

```text title="Bruno"
assert {
  res.status: eq 200
  res.body.id: isDefined
  res.body.name: eq "Ada"
}
```

```text title="API Workbench"
status 200
json-exists $.id
json $.name equals "Ada"
```

Values that a Bruno script sets with `bru.setVar()` become [captures](../variables.md#capture-values-from-responses) in the request's **Vars** tab.

## 5. Go both ways

API Workbench exports Bruno `.bru` requests and environments too — see [Import and export](../import-export.md) — so teammates who stay on Bruno can still use your collections.
