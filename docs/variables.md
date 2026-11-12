---
description: Use {{variables}} in requests — where their values come from, the Vars tab's captures, dynamic values, scripts, data files, and the command line.
navTitle: Variables
icon: variable
---

# Variables

A variable is a name in double braces, such as `{{base_url}}`, that is replaced with a value when the request is sent. Variables keep hosts, IDs, and tokens out of your requests, so one collection works against every stage of an API, and let one request use what another returned.

## Use a variable

Write `{{name}}` in a request's URL, query parameters, headers, body (raw text and form fields), or authentication:

```text
POST {{base_url}}/orders?tenant={{tenant}}
Authorization: Bearer {{token}}

{ "sku": "{{sku}}", "requestId": "{{$guid}}" }
```

- Names are case-sensitive, and the spaces around them are ignored: `{{ token }}` is `{{token}}`.
- A variable that is switched off in its environment is not used.
- A variable with no value is sent as written, braces and all. The line under the URL bar says which environment is in use and lists any variable it cannot resolve, before you send.

## Where values come from

When a request is sent, each `{{name}}` takes the first value found, in this order:

| Order | From                                                             | When                                                     |
| ----- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| 1     | The current row of a [data file](runner.md#run-with-a-data-file) | In a collection run with data: each column is a variable |
| 2     | The **active environment**                                       | Always — see [Environments](environments.md)             |
| 3     | A [dynamic value](#dynamic-values) such as `{{$guid}}`           | When the name is a built-in one                          |

So a data row overrides the environment for that iteration, and an environment can define a variable named like a built-in one to override it.

## How variables get values

| Way                                                                   | Sets                                                    | Kept                            |
| --------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| **Environments** screen                                               | Any variable, by hand                                   | In the environment              |
| A request's **Vars** tab ([captures](#capture-values-from-responses)) | A value from each response, after it arrives            | In the active environment       |
| A [script](scripts.md) with `aw.vars.set(name, value)`                | Anything a script can work out, before or after sending | In the active environment       |
| A [data file](runner.md#run-with-a-data-file) in a run                | One value per column, per row                           | For that iteration only         |
| `--var name=value` on the [command line](cli.md)                      | A value for one run                                     | For that run only, unless saved |

Captured and script-set values switch the variable on, and are created when they do not exist yet. Objects and arrays are saved as compact JSON.

## Capture values from responses

Each request has a **Vars** tab: a table of **captures**, each saving a value from the request's response into a variable of the active environment, for later requests to use. For example, capture the token from a sign-in response:

| Variable     | Source                |
| ------------ | --------------------- |
| `token`      | `body.token`          |
| `request_id` | `header.x-request-id` |

The tab helps you write sources:

- **Autocomplete:** type in **Source** and the options follow what you type — the kinds of source (`body.`, `header.`, `cookie.`, `status.code`, `status.text`, `body`, `$.`, `regex`, `between`, `html`, `form`, `timing`, `certificate`, `error`), then what the last response holds: the paths of its body, whatever format it is in, with the value at each, and its headers, cookies, and form fields, and timing phases and certificate fields. After `|`, the transforms. Press <kbd>Ctrl Space</kbd> to show them, <kbd>↑</kbd> <kbd>↓</kbd> to move, and <kbd>Enter</kbd> to choose; choosing a kind or a path that needs more opens the next options.
- **Kind:** a badge before each source says what it reads — **Body**, **JSON**, **Header**, **Cookie**, **Status**, **Regex**, **HTML**, **Timing**, **TLS**, and so on. The arrow at the end of the field opens the suggestions: each on one row, with an icon for what it reads, the body's format (**JSON**, **XML**, …) as a tag, and the value on the right, under headings (**Sources**, **From the response**, **Body**, **Headers**, **Transforms**, …) that count their entries, with the keys at the foot.
- **Checked as you write:** a source that cannot work is flagged before any send — an unknown source or transform, an invalid path or regular expression, a timing or certificate field that does not exist, `between` without two markers, or a `|` with nothing after it. A likely slip comes with a fix to apply in one click, such as **Use jwt** for `jwtt` or **Use header** for `headr`. While you are still typing a path or a transform, it waits until you finish.
- **Preview:** under each source, what it captures from the last response, with its type (**Text · 12**, **Number**, **List of 3**, **Object**) and **Copy** — or why it does not (_JSON path $.missing is missing_; in a chain, which step failed). Values of secret-looking variables, such as `session_token`, are hidden until you click **Show**. Before a first send, the preview says to send the request.
- **Steps:** a source with transforms shows **2 steps** (or more); open it to see the value after each step, which failed, and which were skipped, to find where a chain goes wrong.
- **Suggested from the last response:** tokens, ids, `Location` and request-id headers, and cookies the response holds, not yet captured. Click one to add it, named after what it reads.
- **Source reference:** every kind of source and transform, grouped, each example with **Add** to start a capture from it.
- The header shows the environment captures are saved into, how many are active and how many update a variable it already has, and whether previews come from a response.

Captures run after each successful response — including in collection runs, where each request sees the values captured by the ones before it. When a request fails, only the captures that read a failure run — `error`, `timing`, and `certificate` — so a timeout can still save why it failed and how long it took; the others are skipped. Objects and arrays are stored as compact JSON.

You can also add a capture from the response itself:

- **Body:** right-click a value in a JSON response body — of the response, or of an entry in [History](history.md) — and choose **Capture value**. The capture uses that value's JSON path and is named after its key, for example `$.data.token` in `{{token}}`; clicking a key captures its value. In other bodies (HTML, XML, or text), select the text first: the capture finds it between the nearest markers that pick it out of the raw body, such as `between "value=\"" "\""`. Clear the response filter first, since a filtered view no longer matches the body.
- **Headers:** right-click a response header — of the response, or of an entry in [History](history.md) — and choose **Capture into a variable**. In the **Raw** view of headers, put the cursor on a line and choose **Capture value**; on a `set-cookie` line it captures the cookie under the cursor.
- **Cookies:** right-click the `set-cookie` row in **Headers** and choose a cookie under **Capture a cookie**, or right-click a cookie in the **Cookies** tab — of the response, or of an entry in [History](history.md) — and choose **Capture into a variable**. Each adds `cookie <name>`.

- **Certificate:** right-click a field of a response's **Certificate** — or an entry's in [History](history.md) — and choose **Capture into a variable**, to save it (`certificate valid-to`) after each send.
- **Compare:** right-click a JSON line, a changed header, or the status, time, or size in a response's **Compare** — or an entry's in [History](history.md) — and choose **Capture into a variable**.
- **Tests:** right-click a result in a response's **Tests** — or an entry's in [History](history.md) — to capture the value its assertion checks: `$.id` for `json $.id equals 7`, `header etag` for a header check, `time` for `response-time`.
- **Console:** in an entry's **Console** in [History](history.md), right-click the outcome line to capture the status, time, or size, the cookie line to capture a cookie, or a failed request's failure line to capture its `error` or total time. A failed entry's error card captures `error` too.
- **Preview:** in a response's **Preview** — or an entry's in [History](history.md) — right-click an element of an HTML page to capture its text or an attribute (a hidden field's value, a link's href), or the page's title or meta content; or select text in an HTML or Markdown preview to capture it between markers.
- **Timeline:** right-click the total or a phase in a response's **Timeline** — or an entry's in [History](history.md) — and choose **Capture into a variable**, to save that timing (`timing dns`) after each send.

In each case, the new capture opens in the **Vars** tab, ready to rename or edit.

### Sources

| Source                                            | Captures                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body.data[0].id`                                 | A value from the body, read as data whatever it is written in: JSON (and `+json` types), XML, YAML, form-encoded, NDJSON (a list of its lines), or CSV (a list of rows by column). The path works as a JSON path does: `body.items[*].id`, `body[0]`, filters.                                     |
| `body.user.@id`, `body.user.name.#text`           | XML: an attribute is `@name`, an element's text beside attributes is `#text`, and repeated elements are a list. Values stay text, as written.                                                                                                                                                      |
| `$.data[0].id`                                    | The same path with `$` for the body. `json $.path` works too.                                                                                                                                                                                                                                      |
| `$.items[*].id`, `$.meta.*`                       | Every match, as a JSON list. `$.items[-1]` counts from the end.                                                                                                                                                                                                                                    |
| `$.users[?(@.role == "admin")].id`                | Items that pass a filter: `==`, `!=`, `<`, `<=`, `>`, `>=`, `=~ /pattern/flags`, or `@.field` to require it                                                                                                                                                                                        |
| `regex /token=([\w-]+)/`                          | A regular expression's first group from the body; add a group number or name, or `0` for the whole match                                                                                                                                                                                           |
| `between "<title>" "</title>"`                    | The text between two quoted markers in the body                                                                                                                                                                                                                                                    |
| `html input[name="csrf"] @value`                  | An element of an HTML body, found by a CSS selector: its text, or the value of an `@attribute` (`html title`, `html meta[name="csrf-token"] @content`)                                                                                                                                             |
| `form access_token`                               | A field of a form-encoded body, decoded                                                                                                                                                                                                                                                            |
| `header.<name>`, `header <name>`                  | A response header, case-insensitive                                                                                                                                                                                                                                                                |
| `cookie.<name>`, `cookie["a.b"]`, `cookie <name>` | The value of a cookie the response sets; the last one, when several (across redirects) share the name. Put a name with a dot in brackets.                                                                                                                                                          |
| `timing <phase>`, `timing <phase> <n>`            | A network timing in milliseconds: `total`, `preparation`, `dns`, `tcp`, `tls`, `waiting` (or `ttfb`), `download`, `sending`, `queueing`, or `stalled`, for the response's request or request `n` of a redirect chain                                                                               |
| `certificate <field>`, `certificate <field> <n>`  | The TLS connection — `host`, `port`, `protocol`, `cipher`, `alpn`, `authorized` — or certificate `n` of its chain (the leaf by default): `subject`, `cn`, `issuer`, `valid-from`, `valid-to`, `days-left` (whole days until it expires), `serial`, `sha256`, `sha1`, `san`, `public-key`, or `pem` |
| `error`                                           | Why the request failed, such as a timeout or a refused connection                                                                                                                                                                                                                                  |
| `status.code`, `status.text`                      | The status code (`200`) or status text (`OK`); `status` is the code too                                                                                                                                                                                                                            |
| `time`, `size`, `body`                            | The time in ms, size in bytes, or the whole body as text                                                                                                                                                                                                                                           |

### Transforms

Add transforms after `|`; they apply in order to the value captured so far:

| Transform                                                    | Result                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `first`, `last`, `at 2`                                      | One item of a list; `at` counts from 0, and `at -1` is the last. On text, `at` gives a character                        |
| `length`                                                     | The number of items, characters, or keys                                                                                |
| `join ", "`, `split ","`                                     | A list's items as text, or text as a list, at the quoted separator (a comma by default)                                 |
| `slice 0 3`                                                  | Part of a list or text: from the first position up to, not including, the second; leave the second out to go to the end |
| `unique`, `sort`, `sort desc`, `reverse`                     | A list without repeats, in order (numbers by value, the rest as text), or back to front; `reverse` also reverses text   |
| `keys`, `values`                                             | An object's keys or values, as a list                                                                                   |
| `trim`, `lower`, `upper`                                     | Text without surrounding spaces, or in one case                                                                         |
| `replace "from" "to"`                                        | Text with every `from` replaced by `to`                                                                                 |
| `prefix "Bearer "`, `suffix "…"`                             | Text with something added before or after it                                                                            |
| `regex /…/`, `between "…" "…"`                               | Part of the value, as the sources above take part of the body                                                           |
| `json $.path`                                                | A value from JSON text, such as a JSON string inside a JSON response                                                    |
| `jwt $.claim`                                                | A claim from a JWT, without verifying its signature                                                                     |
| `base64-decode`, `base64-encode`, `url-decode`, `url-encode` | Decoded or encoded text                                                                                                 |
| `sum`, `min`, `max`, `avg`                                   | The total, smallest, largest, or average of a list of numbers (numbers written as text count)                           |
| `round`, `round 2`                                           | A number rounded to whole numbers, or to that many decimal places                                                       |
| `add 5`, `subtract 5`, `multiply 2`, `divide 100`            | A number with arithmetic applied                                                                                        |
| `date`, `epoch`, `epoch-ms`                                  | A date or a Unix time as an ISO 8601 date, or as Unix time in seconds or milliseconds                                   |
| `if-empty "value"`                                           | The value to use when the result is empty: empty text, an empty list or object, or null                                 |
| `default "value"`                                            | The value to use when a step before it fails                                                                            |

For example, `$.token | jwt $.sub` saves the token's subject, `$.items[?(@.active)].id | first` the first active item, `$.next | regex /cursor=([^&]+)/ | url-decode` a pagination cursor, `$.items[*].price | sum | round 2` an order total, and `$.expires_in | add 0 | multiply 1000` a lifetime in milliseconds. A `|` inside a regular expression or quoted text belongs to it, not to the next step. The response filter in the Body tab accepts the same JSON paths and filters.

For cookies set by responses, see [Cookies](cookies.md). For a step-by-step example, see the guide [Chain requests with captured variables](guides/chain-requests.md).

## Dynamic values

Built-in variables, starting with `$`, give a fresh value every time they are used, and need no environment:

| Variable                                                   | Value                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `{{$guid}}`, `{{$uuid}}`                                   | A random UUID v4                                                                    |
| `{{$timestamp}}`, `{{$timestampMs}}`                       | Unix time in seconds or milliseconds                                                |
| `{{$isoTimestamp}}`, `{{$isoDate}}`                        | The current time as ISO 8601, or the date as YYYY-MM-DD                             |
| `{{$randomInt}}`, `{{$randomFloat}}`, `{{$randomBoolean}}` | A whole number from 0 to 1000, a number with two decimals below 1000, or true/false |
| `{{$randomHex}}`, `{{$randomAlphaNumeric}}`                | A random 16-character hex or 12-character alphanumeric string                       |
| `{{$randomEmail}}`, `{{$randomUserName}}`                  | A random example.com address or user name                                           |
| `{{$randomFirstName}}`, `{{$randomLastName}}`              | A random first or last name                                                         |
| `{{$randomIP}}`                                            | A random IPv4 address                                                               |

```json
{ "id": "{{$guid}}", "email": "{{$randomEmail}}", "createdAt": "{{$isoTimestamp}}" }
```

## In scripts

Scripts read and change the same variables: `aw.vars.get('token')`, `aw.vars.set('order_id', id)`, `aw.vars.unset('draft')`, `aw.vars.has('token')`, and `aw.vars.toObject()` for all of them. A value a pre-request script sets is used in the same request, and one a post-response script sets is there for the next. In a run with data, `aw.vars` includes the current row. See [Scripts](scripts.md#the-aw-api).

## In tests

Assertions in a request's **Tests** tab are checked as written: `status {{expected}}` is not filled from the environment. In a collection run with a data file, the row's columns are filled in, so a row can carry the value it expects — see [Run with a data file](runner.md#run-with-a-data-file). For a check that needs a variable, use a post-response [script](scripts.md): `aw.expect(body.id).toBe(Number(aw.vars.get('order_id')))`.

## In collection runs

A [collection run](runner.md) uses the environment chosen for it. Each request sees the values captured, and set by scripts, in the requests before it, so a run can sign in, keep the token, and use it in every request after. What a run captures stays in that environment afterwards, as it would from single sends.

## Secrets

Variable values are saved as plain text with the workspace. Values that look secret get some protection on the way out:

- **On screen:** variables whose names contain _secret_, _token_, _password_, or _key_ are masked on the **Environments** screen until you click the eye, and captures into them show their value only when you click **Show**.
- **Exports:** the values of variables named like _token_, _password_, _secret_, _api key_, _credential_, _cookie_, or _authorization_ are left empty in exported collections and environments.
- **Command line:** `environment show` hides secret-looking values, and run reports never include variable values.

> [!WARNING]
> Keep long-lived secrets — API keys, client secrets, passwords — in the [credential vault](credentials.md), which is encrypted and applies them when a request is sent. Use variables for values that change as you work, such as a token captured from a sign-in response.

## From the command line

The [command line](cli.md) runs requests with the same variables:

- `-e Staging` chooses the environment; without it, a run uses the first one.
- `-v name=value` sets a variable for the run, over the environment's value. `-v name` reads the process's environment variable of the same name, which keeps secrets out of the command and the log.
- `--data rows.csv` runs once per row, with each column as a variable.
- `environment set Staging base_url=https://staging.example.com` saves variables to an environment, and `environment show` lists them, with secret-looking values hidden. See [Environments](cli.md#environments).

## Related

- [Environments](environments.md) — create, switch, and edit environments
- [Chain requests with captured variables](guides/chain-requests.md) — a step-by-step guide
- [Scripts](scripts.md) — `aw.vars` and everything else scripts can do
- [Run with a data file](runner.md#run-with-a-data-file) — data-driven collection runs
