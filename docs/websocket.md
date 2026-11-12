---
description: Open a WebSocket connection, send text or binary frames, and watch messages arrive.
icon: swap-horizontal
---

# WebSocket

## Connect

1. Choose **WebSocket** under **Live protocols** in the select at the start of the URL bar (where HTTP requests choose their method).
2. Enter a `ws://` or `wss://` URL, and any handshake headers in **Headers**.
3. Click **Connect**.

## Send and receive

1. Write a message in **Message** — JSON is highlighted and can be formatted.
2. Click **Send message**. Turn on **Binary (base64)** to send base64 text as a binary frame.
3. Incoming and outgoing messages appear in the response as they happen.

Click **Disconnect** when you are done. The response keeps the session's messages, headers, and timeline.

> [!NOTE]
> Authorization headers, saved credentials, and OAuth 2.0 tokens are sent on the opening handshake. Browsers cannot send handshake headers, which is worth remembering when you move generated JavaScript to a web page.

## Generate a client

**Code** produces the connection as websocat, browser JavaScript, Node.js (`ws`), Python (`websockets`), or Go (`gorilla/websocket`), with your message and headers — see [Code snippets](code-snippets.md#realtime-protocols).
