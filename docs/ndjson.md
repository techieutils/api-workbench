---
description: Read newline-delimited JSON streams one complete message at a time.
icon: format-list-bulleted
---

# NDJSON streams

NDJSON (newline-delimited JSON, also called JSON Lines) streams one JSON value per line — common for logs, exports, and progress feeds.

1. Choose **NDJSON** under **Live protocols** in the select at the start of the URL bar (where HTTP requests choose their method).
2. Enter the stream URL and any headers.
3. Click **Connect**.

Each complete line appears as its own message, even when a line arrives split across several chunks. **Pretty** combines the values into an array.

## Generate a client

**Code** produces the stream as cURL piped to `jq`, Fetch streams for the browser and Node.js, Python (Requests), or Go. See [Code snippets](code-snippets.md#realtime-protocols).
