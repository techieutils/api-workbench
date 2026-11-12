---
description: Call gRPC services from a .proto schema — unary, server, client, and bidirectional streaming.
icon: lan-connect
---

# gRPC

## Make a call

1. Choose **gRPC** under **Live protocols** in the select at the start of the URL bar (where HTTP requests choose their method).
2. Paste or import a self-contained `.proto` file in the **Schema** tab, and click **Discover methods**.
3. Choose a method, enter the server as `host:port`, and write the request message as JSON.
4. Click **Invoke**.

Metadata, messages, status, and errors appear live. Turn on **TLS** to connect securely with system certificate validation.

## Streaming

All four call types are supported:

| Call type        | How to use it                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unary            | **Invoke** sends the message and shows the reply.                                                                        |
| Server streaming | **Invoke** sends the message; replies arrive as they are streamed.                                                       |
| Client streaming | **Invoke** sends the first message; **Send message** sends more; **Finish sending** closes your side and gets the reply. |
| Bidirectional    | As client streaming, with replies arriving throughout.                                                                   |

## Metadata

Add metadata in the **Metadata** tab. Keys ending in `-bin` take base64 values and are sent as binary metadata. Authorization from the **Auth** tab is sent as metadata too.

> [!WARNING]
> gRPC has no query string, so an API key configured to go in the query is refused — send it as a header (metadata) instead. Proto imports between files and server reflection are not supported yet.

## Generate a client

**Code** produces the call as grpcurl, Node.js (`@grpc/grpc-js`), or Python (`grpcio`), following the method's call type. See [Code snippets](code-snippets.md#realtime-protocols).
