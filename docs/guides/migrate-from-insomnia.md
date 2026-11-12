---
description: Bring Insomnia collections and environments into API Workbench, and secure their secrets.
icon: weather-night
---

# Migrate from Insomnia

## 1. Export from Insomnia

1. In Insomnia, open the collection, then open the menu next to its name and choose **Export**.
2. Pick **Insomnia v5** (YAML) or **Insomnia v4** (JSON). Both work.
3. To move everything at once, use **Preferences → Data → Export the data** instead.

The export includes the collection's base environment and its sub-environments, so you don't need to export environments separately.

## 2. Import

1. In API Workbench, click **Import** in the explorer.
2. Choose the exported file — or several, or a ZIP of them.
3. Check the preview: it lists the requests and environments it found, with a note for anything that could not be converted.
4. Click **Import into workspace**. Nothing changes unless the whole import is valid.

## 3. What comes across

| Insomnia                                                 | In API Workbench                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request folders                                          | Collections, nested by path                                                                                                                               |
| Requests, query params, headers, bodies                  | Requests, including JSON, GraphQL, multipart, urlencoded, and file bodies                                                                                 |
| Folder auth                                              | Inherited by the requests inside                                                                                                                          |
| WebSocket requests                                       | WebSocket requests                                                                                                                                        |
| Base environment and sub-environments                    | One environment each                                                                                                                                      |
| `{{ _.variable }}`                                       | `{{variable}}`                                                                                                                                            |
| gRPC requests                                            | **Skipped** — recreate them and load the proto. See [gRPC](../grpc.md)                                                                                    |
| Template tags such as `{% response %}` and `{% faker %}` | **Kept as text** — use [captures](../variables.md#capture-values-from-responses) and [dynamic values](../variables.md#dynamic-values) such as `{{$guid}}` |
| Pre-request and after-response scripts                   | **Not imported** — rewrite tests as [assertions](../tests.md) or [scripts](../scripts.md) with the `aw` API                                               |

> [!WARNING]
> Imported tokens and passwords arrive as plain text in auth fields and environment values. Move long-lived ones into the [credential vault](../credentials.md) and use **Saved credential**.

## 4. Replace request chaining

Insomnia chains requests with a template tag that reads another request's response:

```text
{% response 'body', 'req_123', 'b64::JC50b2tlbg==::46b', 'when-expired', 60 %}
```

In API Workbench, the request that returns the value captures it instead. On **Sign in**, open **Vars** and add a capture:

| Variable | Source    |
| -------- | --------- |
| `token`  | `$.token` |

Other requests then use `{{token}}`. See [Chain requests with captured variables](chain-requests.md).

## 5. Recreate tests

An Insomnia after-response test and its API Workbench equivalent:

```javascript
insomnia.test('ok', () => insomnia.expect(insomnia.response.code).to.eql(200));
insomnia.test('has id', () => insomnia.expect(insomnia.response.json().id).to.exist);
```

```text
status 200
json-exists $.id
```

## 6. Go both ways

API Workbench exports Insomnia v5 YAML and v4 JSON too — see [Import and export](../import-export.md) — so teammates who stay on Insomnia can still use your collections.
