---
description: Sign in once, capture the token from the response, and reuse it in later requests and runs.
icon: link-variant
---

# Chain requests with captured variables

Many APIs return a value — a token, an ID, a cursor — that later requests need. **Captures** save it into the active environment automatically.

## 1. Capture a token on sign-in

1. Create a request `Sign in`: `POST {{base_url}}/login` with a JSON body holding your username and password.
2. Open its **Vars** tab and add a capture:

   | Variable | Source    |
   | -------- | --------- |
   | `token`  | `$.token` |

3. Send it. The token is saved into the active environment as `token`.

Sources can be a JSON path (`$.data[0].id`), `header <name>`, `status`, `body`, or `time`.

## 2. Use it in other requests

Set the other requests' **Auth** tab to **Bearer token** with `{{token}}` — or set it once on the collection and choose **Inherit from collection** in each request. See [Authorization](../authentication.md).

## 3. Capture IDs as you go

Capture the ID of something you create, then use it in the next request:

| Request           | Capture               | Used in                                  |
| ----------------- | --------------------- | ---------------------------------------- |
| `Create an order` | `order_id` ← `$.id`   | `GET {{base_url}}/orders/{{order_id}}`   |
| `Get the order`   | `status` ← `$.status` | A test: `json $.status equals "pending"` |

## 4. Run the chain

In a **collection run**, requests run in explorer order and each one sees the values captured by those before it. Order them by dragging, or with <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd>, so `Sign in` comes first.

> [!NOTE]
> Benchmarks and performance tests use the environment as it was when the run started, so every sample is independent. Use a collection run for chained workflows.

> [!WARNING]
> Captured values are stored in the environment as plain text. For long-lived secrets, use the [credential vault](../credentials.md) and OAuth 2.0 instead of capturing tokens.
