---
description: Serve canned responses and streams on localhost — HTTP, WebSocket, SSE, NDJSON, gRPC, Socket.IO, and MQTT — from hand-written routes, a collection, or an API specification.
icon: server-network
---

# Mock servers

**Mocks** in the navigation rail runs local servers that answer with responses you define — over HTTP, or as [WebSocket, SSE, NDJSON, gRPC, Socket.IO, and MQTT streams](#live-protocols). Use one while the real API is still being built, to reproduce an error on demand, or to test a front end without a backend.

Mock servers listen on `127.0.0.1` only, so nothing outside your machine can reach them. They run while the app is open.

## Create a mock server

- **New mock server** starts with one route, `GET /health`, that answers `{"status": "ok"}`.
- **New from a collection** makes a route for each request in a collection. Each HTTP route answers with the request's last saved response, or `200 {}` if it has none; WebSocket, SSE, NDJSON, gRPC, Socket.IO, and MQTT requests become [streaming routes](#live-protocols) with sample messages (a Socket.IO route takes the request's event, and an MQTT route its first subscription's topic), and gRPC routes use the schema of the collection's first gRPC request. You can also right-click a collection in the explorer and choose **Create mock server**. **Start mock** on the [API documentation](api-documentation.md) page does the same and starts it, or starts the mock already made from that collection.
  A mock made from a collection stays in step with it, both ways. Each route you add to the mock is added to the collection as a request — after its last request, pointing where its other requests do (such as `{{baseUrl}}/orders/{{id}}` for the route `/orders/:id`) — and changing the route's method, path, or name changes that request. Each request added to the collection, however it is added (made, copied, imported, from cURL or a specification, or moved in), becomes a route on the mock, as **New from a collection** makes routes, and changing the request's method, URL, or name changes its route. Renaming the collection keeps it the mock's. Either side changed on its own is left as you made it, a copied route gets a request of its own, one already answering the same is linked rather than repeated, and removing a route or a request keeps the other. A running mock serves the change after a moment. The mock's header says whether the two are **In step with it**, or how many requests have no route and routes have no request; **Sync now** adds what is missing on both sides, including what was removed on one side. Requests a teammate adds in a pulled team folder are theirs to sync.
- **Start mock** on an [API specification](api-specs.md) makes a route for each operation, using its examples, and starts the mock at once.

Each new mock takes the first port from **4010** that no other mock uses; a mock started for you from a specification or the documentation page moves on to the next free port if another program holds that one. Change **Port** to any port from 1024 to 65535.

## Server settings

Under the mock's figures, **Server settings** holds what applies to every route, as a row of tiles. Each tile shows the setting's state in words — **On**, **Off**, or what it needs, such as **Needs schema** or **1 missing** — and its key value, such as the origins allowed or the port. The card's header counts how many are on and how many need attention.

Click a tile to open its settings in the panel under the tiles; click it again, the close button, or press <kbd>Esc</kbd> to close it. One setting is open at a time, so the routes stay in view.

| Setting             | Its tile shows                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **CORS**            | Whether cross-origin requests are allowed, and which origins — see [Start and stop](#start-and-stop).                     |
| **HTTPS**           | Plain HTTP, the API Workbench CA, or your own certificate — see [HTTPS](#https).                                          |
| **Default headers** | How many headers go on every answer, and how many security headers are missing — see [Default headers](#default-headers). |
| **gRPC**            | The port and the schema's method count, or that gRPC routes need a schema — see [gRPC](#grpc).                            |
| **MQTT broker**     | The broker's port while the mock has MQTT routes — see [MQTT](#mqtt).                                                     |

CORS and HTTPS have a switch in their panel's header. CORS fields are grouped by **Who can call** (origins, methods, and request headers) and **What browsers get** (readable headers, preflight cache, and credentials). Choosing **gRPC** or **MQTT** for a route opens that setting.

## Start and stop

**Start** begins serving at `http://localhost:<port>`; **Stop** ends it. The list marks running mocks. Edits to a running mock (routes, headers, bodies, delays, CORS) apply at once, and changing its port moves it.

**Allow cross-origin requests**, in the **CORS** panel of [Server settings](#server-settings), lets a web app on another origin call the mock: it answers browser preflight requests and adds CORS headers. It is on, and permissive, by default. Open the **CORS** panel (marked On or Off) to switch it, and, while it is on, to set:

| Setting                   | Default                                        | Meaning                                                                                             |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Allowed origins           | `*`                                            | Origins that get CORS headers, comma-separated; others get none, as a real server would answer them |
| Allowed methods           | `GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS` | Methods a preflight allows                                                                          |
| Allowed request headers   | `*`                                            | Headers a preflight allows                                                                          |
| Headers scripts can read  | `*`                                            | Response headers exposed to the page (`Access-Control-Expose-Headers`)                              |
| Preflight cache (seconds) | `0`                                            | How long a browser may reuse a preflight answer; `0` sends no `Access-Control-Max-Age`              |
| Allow credentials         | Off                                            | Sends `Access-Control-Allow-Credentials: true` for cookies and authorization                        |

Browsers refuse `*` once credentials are allowed, so the mock then echoes the request's own origin (with `Vary: Origin`) and the headers its preflight asks for. **Reset to permissive** goes back to the defaults. Changes apply to a running mock at once.

## HTTPS

Open the **HTTPS** panel in [Server settings](#server-settings) (marked On or Off) and tick **Serve over HTTPS** to serve the mock at `https://localhost:<port>`. Changing it restarts a running mock; if the switch cannot be made, the mock keeps running as it was and says why. Choose the certificate:

- **API Workbench CA** — a certificate for `localhost`, `127.0.0.1`, and `::1` from the app's local certificate authority, the same one the [Interceptor](interceptor.md) uses. Browsers and tools accept it once the CA is trusted: **Trust the CA…** asks your system to trust it, and **Save CA certificate…** saves it to add elsewhere (for example a phone or another tool). The CA's private key is protected by your operating system's encryption, so this needs it to be available.
- **My certificate files** — your own PEM certificate and key, such as [mkcert](https://github.com/FiloSottile/mkcert) makes. Choose both.

Clients must trust the certificate; with curl, for example, pass `--cacert` with the saved CA certificate.

## Default headers

**Default headers** (a panel in [Server settings](#server-settings), with how many are on) are sent on every answer: route answers, the mock's own 404s and errors, and CORS preflights. A route's own header of the same name wins, so a route can still say `Cache-Control: max-age=60`. Values can use templates, like route headers.

New mock servers start with security headers a careful API would send:

| Header                       | Value                                        |
| ---------------------------- | -------------------------------------------- |
| `X-Content-Type-Options`     | `nosniff`                                    |
| `X-Frame-Options`            | `DENY`                                       |
| `Referrer-Policy`            | `no-referrer`                                |
| `Content-Security-Policy`    | `default-src 'none'; frame-ancestors 'none'` |
| `Permissions-Policy`         | `camera=(), microphone=(), geolocation=()`   |
| `Cross-Origin-Opener-Policy` | `same-origin`                                |
| `Cache-Control`              | `no-store`                                   |

Edit, untick, or remove any of them in the table, and add your own. **Add security headers** adds back any that are missing, and gives them to a mock made before they existed. `Strict-Transport-Security` is not included, since mocks serve plain HTTP, nor `Cross-Origin-Resource-Policy`, which would keep pages on other origins from loading what the mock answers.

## The mock's header

The selected mock's header shows its name — click it to rename — with whether it is running, how many routes it has, and what it was made from, then its **Port** and **Start** or **Stop**. Under it, **Endpoints** lists the addresses it serves, each with a copy button.

## At a glance

The selected mock shows its figures under its status: how many routes are on, the protocols it serves, the requests it answered, how many failed (a `4xx` or `5xx` answer, or a gRPC call that did not end OK) and what share that is, the average time, and when the last request came in. Each mock in the list shows its port, route count, and a chip per protocol with its number of routes.

## Routes

Each route has a method, a path, a status, response headers, a body, and an optional delay. The method and path sit in the same bar a request's method and URL use, after the mock's address, with each method's icon and colour. Response headers use the same table as a request's **Headers** tab: type in the last row to add one, untick a row to leave it out, and drag rows to reorder them. Header names and values are suggested from common response headers, such as `Set-Cookie`, `Location`, `Retry-After`, and the CORS and rate-limit headers. Header values are templates too, like the body — `/teams/{{body.team}}` or `{{$uuid}}` — and their suggestions include the templates; environment variables are not filled in.

| Path         | Matches                                             |
| ------------ | --------------------------------------------------- |
| `/users`     | Exactly `/users` (a trailing slash does not matter) |
| `/users/:id` | `/users/42`, with `id` = `42`                       |
| `/files/*`   | `/files/a/b.txt` and anything else under `/files`   |

**Any method** matches every method, and `GET` routes also answer `HEAD`. When several routes match, the one with the most fixed path segments wins (so `/users/me` beats `/users/:id`), then the one listed first. A request no route matches gets a `404` with a JSON message.

**Content type**, above the body, sets the route's `Content-Type` header the way a request's raw body does: JSON, text, XML, HTML, CSV, YAML, NDJSON, Problem JSON, an event stream, binary, or a **Custom** type. **None** sends no `Content-Type` header. The body editor highlights the body to match, and **Format** (also in the editor's right-click menu) tidies JSON, XML, HTML, YAML, and the other formattable types; it is unavailable for plain text.

### Templates in the body

The body is a template, filled in for every request. Type `{{` in the body (or press **Ctrl+Space** inside one) for suggestions that narrow as you type, each with what it gives; **Enter** or a click inserts the whole template. **Insert template** lists every template, grouped and described, and puts the one you choose at the cursor; **Preview** shows a sample answer below the body (path parameters show their own names), and **New sample** draws fresh fake values.

| Template                                                                                         | Value                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{params.id}}`                                                                                  | The path parameter `id`                                                                                                                                                                                                                |
| `{{query.page}}`                                                                                 | The query parameter `page`                                                                                                                                                                                                             |
| `{{headers.x-request-id}}`                                                                       | A request header (any letter case)                                                                                                                                                                                                     |
| `{{body.user.id}}`                                                                               | A value at a JSON path in the request body; `{{body}}` is the whole body                                                                                                                                                               |
| `{{$uuid}}`, `{{$randomFullName}}`, `{{$randomEmail}}` …                                         | Fake data, like faker: names, job titles, phone numbers, companies, products, prices, currencies, addresses, cities, countries, coordinates, URLs, IP and MAC addresses, user agents, colours, words, sentences, paragraphs, and dates |
| `{{$randomInt 1 100}}`, `{{$randomFloat 1 10 2}}`, `{{$randomPrice 5 50}}`, `{{$randomWords 3}}` | Fake values within a range, or of a size                                                                                                                                                                                               |
| `{{$pick small medium large}}`                                                                   | One of the words given                                                                                                                                                                                                                 |
| `{{#repeat 3}}…{{/repeat}}`                                                                      | The block 3 times, joined with commas; `{{#repeat 2 5}}` repeats 2 to 5 times. Blocks can nest.                                                                                                                                        |
| `{{@index}}`                                                                                     | The position in the repeat, from 0                                                                                                                                                                                                     |

For example, this body answers with a list of three people:

```json
{
  "team": "{{query.team}}",
  "people": [
    {{#repeat 3}}{ "id": {{@index}}, "name": "{{$randomFullName}}", "email": "{{$randomEmail}}" }{{/repeat}}
  ]
}
```

Unknown `{{$names}}` are left as written, so a typo shows in the answer; unknown request values are empty. A template that would make a body larger than 5 MB answers `500` with a message instead.

Right-click a route to disable, duplicate, move, or delete it. A disabled route never answers.

## Path parameters

A `:name` segment in a route's path takes that part of the request path as a value: `/users/:id` matches `/users/42` with `id` = `42`, available as `{{params.id}}` in templates. The **Path parameters** table in the **Match** step lists each one. Type a name in its last row and press <kbd>Enter</kbd> (or **Add to path**) to add `/:name` to the end of the path; edit a name to rename it in the path, keeping its details; and **×** takes it out of the path. Typing `:name` in the path works too. Each parameter has:

- **Type**: **Any value** (the default), **Integer**, **Number**, **Boolean**, **UUID**, **Date** (YYYY-MM-DD), **One of…** (the **Allowed values**, separated by commas), or **Pattern** (a regular expression in **Allowed values**).
- **Example**: used in **Try it**, so `/users/:id` with example `42` is tried at `/users/42`.
- **Description**: what it identifies.

Types are checked as part of [validation](#validation): a request whose parameter does not fit — `/users/abc` for an integer `id` — gets the failure answer, with a problem such as _path parameter id must be an integer_. Giving a parameter its first type turns validation on for the route. Routes made from an [API specification](api-specs.md) take their path parameters' types, enums, patterns, examples, and descriptions from it.

## Validation

A route's **Validate** step checks a matched request before it is answered, and answers one that fails with the problems instead of the route's response — as a real API would reject a bad request. Tick **Validate requests before answering**, then add:

- **Required** checks, in the same table as rules: a query parameter, header, path parameter, or body field that must be present, absent, equal a value, contain text, or match a pattern. For gRPC they check **Metadata** and **Message field**; a WebSocket handshake has no body.
- A **Body schema** (for gRPC, **Message schema**): a JSON Schema the JSON body must satisfy — types, `required`, `properties`, `additionalProperties`, `enum`, lengths, ranges, `pattern`, `format` (email, uuid, date, date-time, uri), item and property counts, `allOf`, `anyOf`, `oneOf`, and OpenAPI's `nullable`. **Schema from sample** describes the body typed in **Test a body** (or the route's own body) as a starting point.
- **Failure status** (422 by default) and an optional **Failure body**, a template where `{{problems}}` is the list as JSON. Without one, the answer is:

```json
{
  "error": "Request validation failed",
  "problems": [
    { "in": "header", "name": "X-Api-Key", "message": "header X-Api-Key must be present" }
  ]
}
```

**Test a body** shows whether a body would pass, and the problems it would get, without sending anything. Each protocol fails in its own way: an HTTP request gets the failure answer, an SSE or NDJSON request gets it instead of the stream, a WebSocket handshake is refused with the failure status, and a gRPC call ends with `INVALID_ARGUMENT` and the problems as its message (a client-streaming call's schema is not checked, since its messages arrive later). The **Log** says _Validation failed, so it got 422_ with each problem.

Routes made from an [API specification](api-specs.md) start with validation from it: the operation's required query and header parameters must be present, its path parameters must fit their types, and a JSON request body must satisfy its schema, with references resolved.

Beside a route's path, its switch turns it **On** or **Off** (an off route never answers), and the buttons duplicate or delete it.

## Request rules

A route can answer only some requests to its path. Its **Request rules** are a table like the headers table: type in the last row to add a rule, untick a rule to switch it off, and remove it with **×**. Each rule checks a **Query** parameter, a **Header**, a **Cookie** the request sent, a **Path** parameter (as in `:id`), or the **Body**, with one of these comparisons. For the body, name a JSON path such as `user.id` or `items[0].sku`, or leave the name empty to check the whole body.

| Group         | Comparisons                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text          | equals, does not equal, equals or does not equal in any case, contains, does not contain, contains or does not contain in any case, starts with, does not start with, ends with, does not end with                                           |
| Pattern       | matches regex, does not match regex — written `^[A-Z]{3}$` or `/^abc$/i`                                                                                                                                                                     |
| List          | is one of, is not one of, contains all of, contains any of — values separated by commas; for a JSON array, its items must hold them                                                                                                          |
| Number        | equals the number, is not the number, is greater than, is at least, is less than, is at most, is between, is not between — ranges written `1..10`                                                                                            |
| Length        | has a length of, at least, at most — characters, or a JSON array's items                                                                                                                                                                     |
| Date          | is before, is after — a date, a date-time, or `now`                                                                                                                                                                                          |
| Kind of value | an integer, a number, true or false, a UUID, an email address, a date (one that exists on the calendar), a URL, an IP address, valid JSON, a JSON array, a JSON object, letters and digits, Base64, hexadecimal, a JWT, uppercase, lowercase |
| Presence      | is empty, is not empty, is present, is missing                                                                                                                                                                                               |

By default every rule must pass; with two or more, choose **Match any rule** instead. A rule without a name is ignored until you name what it checks, and an invalid pattern is pointed out under the table.

When several routes match a request, the one with the most fixed path segments still wins; among those, a route whose rules pass wins over one without rules. Routes with rules show a filter mark and their rule count in the list.

## Responses

A route can give different answers to the same request path. **Default** is the route's own status, delay, headers, and body. **Add response** adds another answer, starting from the route's headers and body, with its own name, **When** rules (the same table), status, delay, headers, and body. Each request gets the first response, in order, whose rules pass, and the default when none does. A response without rules is never used.

For example, `GET /stock/:sku` answers `200` by default, with a response _Out of stock_ (`409`) when the path parameter `sku` matches `^X`, and another (`503`, delayed 2 seconds) when the query parameter `slow` is present. The **Log** names the response that answered.

## Live protocols

The box before a route's path chooses an HTTP method — including **TRACE** and **CONNECT** (see [TRACE and CONNECT routes](#trace-and-connect-routes)) — or, under **Live protocols**, **WebSocket**, **SSE**, **NDJSON**, **gRPC**, **Socket.IO**, or **MQTT**. The arrow beside **Add route** adds a route of a chosen protocol straight away.

Each method in the box says what it is for, such as _Read a resource_ for GET or _Every method_ for ANY, as in a request's method box. Each protocol keeps its own colour, so routes are easy to tell apart:

- **Endpoints**: beside the mock's status, its HTTP address, and its WebSocket (`ws://`), gRPC (`localhost:<gRPC port>`), Socket.IO, and MQTT (`mqtt://localhost:<MQTT port>`, and `ws://localhost:<port>/mqtt`) addresses when it has such routes, each with a copy button.
- **Route list**: **Filter by method, path, or name** narrows it. Like the Collections explorer, routes sit in folders by protocol — **HTTP**, **WebSocket**, **SSE**, **NDJSON**, **gRPC**, **Socket.IO**, and **MQTT**, each with its count — that fold away with their chevron. Each route row shows its method or protocol, its name, and its path underneath, with marks for rules and validation and its status or message count.
- **Route card**: at the top of the route editor, what the route does, how it runs (for example _Client calls (server streaming) → sends 2 messages, 20 ms apart → ends with status 0_), the gRPC method's streaming kind from the schema, and **Try it**, a command to call it: `curl` for HTTP, `curl -N` for SSE and NDJSON, `wscat` for WebSocket (and for Socket.IO's raw frames), `grpcurl` for gRPC, or `mosquitto_sub` for MQTT. Copy it, or click the terminal icon to open it in a new [terminal](dev-tools.md#terminal), at the prompt, ready to run with <kbd>Enter</kbd>.
- **Route steps**: the route editor's **Match** (the rules, summed up as, for example, _GET /users, when its rule passes_), **Validate** (see [Validation](#validation)), and **Respond** or **Stream** (the answer or messages, summed up as the status or the stream's flow) steps are expansion panels, like a request's **Settings**. Each shows its summary and a count (rules, checks, responses, or messages) while closed; **Collapse all** / **Expand all** switches them together, and closed steps stay closed as you move between routes. The log labels gRPC statuses by name (`0 OK`, `5 NOT_FOUND`) and a WebSocket's `101 Connected`.
- **Rules in the protocol's terms**: **Handshake rules** for WebSocket (query, header, or path) and Socket.IO (query, header, path, or a field of the **Auth payload**), **Call rules** for gRPC (**Metadata** or a **Message field**), **Message rules** for MQTT (the **Client** — `client-id` or `username` — a **Topic level**, or the **Payload**), and **Request rules** otherwise. Messages are listed as **Events** (SSE), **Lines** (NDJSON), **Messages sent** (WebSocket), **Response messages** (gRPC), **Events emitted** (Socket.IO), or **Messages published** (MQTT), each with the time it is sent on the first pass. A live route sends a list of **Messages** instead of one body:

- Each message is a template, like a body, so it can use [request values and fake data](#templates-in-the-body).
- **Start delay** waits before the first message, **Every** sets the gap between messages, and **Repeat until the client disconnects** starts again from the first message.
- Move messages up or down, or remove them. Request rules still apply: they check the query, headers, and path of the request that opens the stream (for gRPC, its metadata and request message).

| Protocol      | What the client gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSE**       | `text/event-stream`: each message is an event, with an optional **event name** and a numbered `id:`; multi-line data becomes several `data:` lines. The route's method still applies.                                                                                                                                                                                                                                                                                                           |
| **NDJSON**    | `application/x-ndjson`: each message is one line, JSON compacted onto a single line. The route's method still applies.                                                                                                                                                                                                                                                                                                                                                                          |
| **WebSocket** | Upgrade at `ws://localhost:<port>/<path>`. The messages are sent once it connects, and **Reply** is sent back for each message received, with that message as `{{body}}` (for example `{"echo": {{body}}}`). Other paths are refused with `404`.                                                                                                                                                                                                                                                |
| **gRPC**      | Calls to the method named in the path, such as `/shop.Orders/Watch`. A unary or client-streaming call gets the first message; a server stream gets them all. **Reply** answers each message of a client- or bidirectional-streaming call.                                                                                                                                                                                                                                                       |
| **Socket.IO** | Connections to the namespace in the path (`/`, or `/orders`), at `/socket.io` on the mock's port, over WebSocket or long polling. Each message is emitted as its **event name** (`message` when empty); JSON is sent as a value. **Reply** answers each event the client emits: as its acknowledgement when it asks for one, otherwise as the same event, with the event's value as JSON in `{{body}}`. A namespace without a route, or a handshake that fails the rules, gets `connect_error`. |
| **MQTT**      | A topic, such as `devices/:id/status` (`+` or `:name` match one level, `#` the rest). A client that subscribes to a topic the route matches gets its messages; a wildcard subscription such as `devices/#` gets those of routes with a fixed topic. **Reply** is published on the topic with `/reply` added (`devices/42/cmd/reply`) for each message a client publishes to it, with the payload as `{{body}}`.                                                                                 |

SSE and NDJSON routes keep their response headers, and the stream's `Content-Type` and `Cache-Control: no-cache` are added. Plain HTTP requests never reach WebSocket, gRPC, Socket.IO, or MQTT routes.

### MQTT

MQTT routes are served by an MQTT 3.1.1 broker the mock runs while it has an enabled MQTT route:

- It listens on its own port, from **1883**, set in the **MQTT** settings, and over WebSocket at `ws://localhost:<port>/mqtt` on the mock's HTTP port. Point an MQTT request at `mqtt://localhost:<MQTT port>` with version **3.1.1**; the broker does not accept MQTT 5.
- It is a real broker: clients can also publish to and subscribe to each other, and topics without a route work as usual. A subscription no route matches is logged with `404`.
- Messages a route publishes are templates; a topic's `:name` levels fill `{{params.name}}`. **Repeat until the client disconnects** is on for new MQTT routes, to stand in for a device that reports regularly.
- An MQTT port that is the mock's HTTP or gRPC port keeps the mock from starting, with the reason.

### TRACE and CONNECT routes

- A **TRACE** route answers like any HTTP route; use templates such as `{{headers.x-forwarded-for}}` to echo what arrived.
- A **CONNECT** route's path is the target after a slash, such as `/api.example.com:443`, or `/*` for any target. Point a request's **Proxy** setting at the mock and send a CONNECT to see your proxy handling — `200`, `403`, or `407` with a page. The mock answers and closes the connection; it never opens the tunnel.

### gRPC

gRPC routes are served over plaintext HTTP/2 on their own port, from a schema:

1. Choose **gRPC** for a route; the **gRPC** settings open, with a free port from **50051**.
2. Paste a self-contained `.proto` schema. Its methods are listed with their streaming kind, and **Add routes for every method** adds a route for each method without one. The route path suggests the schema's methods as you type.
3. Write each route's messages as JSON for the method's response type.

**gRPC status** ends each call: **0 · OK**, or an error code such as **5 · NOT_FOUND** with an **Error message** (a template too, such as `Order {{body.id}} not found`). Calls to methods without a route get `UNIMPLEMENTED`. Point a gRPC request at `localhost:<gRPC port>` with TLS off. A schema that cannot be read, or a gRPC port that is the mock's own HTTP port, keeps the mock from starting, with the reason.

## Log

**Log** lists the latest 200 requests each mock answered: the method (or **WS**, **SSE**, **NDJSON**, **gRPC**, **SIO**, or **MQTT** for a stream), path or topic, status (`101` for a WebSocket or Socket.IO connection, the gRPC status code for a call, `200` for an MQTT subscription or message a route answered), the route (and response) that answered, how long it took, and when. Search it by method, path, status, or route, or filter it by status class; **No match** shows the requests no route answered. **Clear** empties it.

Select a request to see:

- For a stream, how its messages are sent and one pass of them as the client receives them.
- **Why** it got its answer: the route that answered and the rules that passed, the responses whose rules did not pass, or — when nothing answered — the routes with that path and what kept each from answering (a different method, a route switched off, or a rule that did not pass, named).
- The path parameters the route took, the delay, and the time.
- **Request** and **Response**: the query, headers, and body of each (bodies up to 64 KB).
- **Go to route** opens the route (and response) that answered; **Copy as cURL** copies the request to send again from a terminal.

## Use a mock from your requests

Point a request at the mock by changing its host, for example by setting `base_url` to `http://localhost:4010` in an [environment](environments.md). Collections generated from the same specification keep the server's base path in their URLs, and so does the mock.

## Where they are saved

Mock servers are saved in the workspace's `mocks` folder, one readable YAML file each with the port, CORS setting, gRPC schema and port, and routes. Edit them in another editor while the app is open and they reload. See [Where your data is stored](installation.md#where-your-data-is-stored).

## From the command line

`api-workbench mock start <mock>` serves a mock server from a terminal or CI pipeline until <kbd>Ctrl C</kbd>, logging each request, for tests that need a stand-in API. See [Mock servers](cli.md#mock-servers).
