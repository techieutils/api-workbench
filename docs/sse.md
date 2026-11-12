---
description: Follow a Server-Sent Events stream and see each event as it arrives.
icon: broadcast
---

# Server-Sent Events

1. Choose **SSE** under **Live protocols** in the select at the start of the URL bar (where HTTP requests choose their method).
2. Enter the event-stream URL (`http://` or `https://`) and any headers.
3. Click **Connect**.

Events appear as they arrive, with their names and IDs; multi-line data and chunks split anywhere — even inside a UTF-8 character — are handled. **Pretty** combines JSON event data into an array.

> [!NOTE]
> After a disconnect, reconnect manually: automatic retry and resume with `Last-Event-ID` are not supported yet.

## Generate a client

**Code** produces the stream as cURL, browser EventSource or a Fetch stream, Node.js, Python (Requests), or Go — each parsing event names, data, and IDs. See [Code snippets](code-snippets.md#realtime-protocols).
