---
description: Connect to a Socket.IO server, emit events with JSON payloads, read acknowledgements, and watch every event arrive.
icon: lightning-bolt-outline
---

# Socket.IO

## Connect

1. Choose **Socket.IO** under **Live protocols** in the select at the start of the URL bar.
2. Enter the server URL with `http://`, `https://`, `ws://`, or `wss://`. The URL's path is the **namespace**: `https://chat.example.com/admin` connects to `/admin`, and a URL with no path connects to `/`.
3. Add handshake headers in **Headers** and authorization in **Auth**, if the server needs them.
4. Click **Connect**.

If the server handles Socket.IO somewhere other than `/socket.io`, change **Socket.IO path** in **Settings**.

## Emit events

1. Enter the event name in **Event**, below the URL.
2. Write the payload in **Message**. JSON is emitted as its value — an object, array, number, or `true` — and any other text as a string. Turn on **Binary (base64)** to emit base64 text as bytes.
3. Click **Emit**.

Turn on **Wait for acknowledgement** to emit with a callback. The server's reply appears in the response as `<event> (ack)`; if none arrives within 10 seconds, the timeline says so.

## Receive events

Every event the server emits appears in the response with its name, so you do not have to list the events to listen for. A single string argument is shown as it is; other arguments are shown as JSON, with several arguments as an array.

In **Timeline**, right-click a message and choose **Use as next message** to load it, with its event, into the editor, or **Send again** to emit a sent message once more as the same event.

## Authorization

Header-based types work: Bearer, Basic, API key in a header, JWT bearer, WSSE, OAuth 2.0, and saved credentials whose origin matches the server (`ws://` maps to `http://`, `wss://` to `https://`). Signatures that cover the URL (AWS Signature, OAuth 1.0, Akamai EdgeGrid, Hawk) and Digest auth are not supported, because Socket.IO adds its own query to the handshake.

> [!NOTE]
> API Workbench connects over WebSocket only, without HTTP long-polling. Servers that allow only polling refuse the connection. Reconnecting after a disconnect is up to you: click **Connect** again.

## Generate a client

**Code** produces the connection for Node.js and browser JavaScript (`socket.io-client`) and Python (`python-socketio`), with your event, payload, path, and headers — see [Code snippets](code-snippets.md#realtime-protocols).
