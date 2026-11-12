# Local protocol playground

Local sample servers, a runnable client/check script, a gRPC schema, and an importable API Workbench collection. Everything binds to `127.0.0.1`; no external services, accounts, or tokens are required. Node.js 22.13+ is required. Dependencies are isolated from the desktop application.

From the repository root:

```sh
npm install --prefix examples/protocol-playground
npm run samples:start
```

In API Workbench, choose **Import** in Collections and open `examples/protocol-playground/collection.json`. This adds 14 requests in **Local playground** without changing environment variables. Start with **Health and available protocols**. Stop the sample servers with Ctrl+C.

## Protocols and endpoints

| Sample                        | Address                                             | How to test                                                                                 |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| HTTP JSON / query echo        | `http://127.0.0.1:4780/echo?name=Workbench`         | GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS; body and headers echoed                    |
| GraphQL                       | `http://127.0.0.1:4780/graphql`                     | POST a query and optional variables; real GraphQL parser/schema                             |
| URL-encoded / multipart forms | `http://127.0.0.1:4780/echo`                        | Collection includes both; multipart is returned as raw text                                 |
| Bearer authentication         | `http://127.0.0.1:4780/auth/bearer`                 | Token `sample-token`; missing/wrong token returns 401                                       |
| Redirect                      | `http://127.0.0.1:4780/redirect`                    | 302 to `/health`                                                                            |
| Compressed JSON               | `http://127.0.0.1:4780/gzip`                        | Gzip response                                                                               |
| HTTP statuses                 | `http://127.0.0.1:4780/status/418`                  | Any status from 200–599                                                                     |
| Delay                         | `http://127.0.0.1:4780/delay?ms=500`                | 1–5000 ms, useful for timing/cancellation                                                   |
| SSE                           | `http://127.0.0.1:4780/events?count=3&interval=100` | Three named events with IDs, then closes                                                    |
| NDJSON                        | `http://127.0.0.1:4780/ndjson?count=3&interval=100` | Three JSON lines, then closes                                                               |
| WebSocket                     | `ws://127.0.0.1:4780/ws`                            | JSON greeting, then text/binary echo                                                        |
| gRPC                          | `127.0.0.1:4781` (plaintext)                        | Import `playground.proto`: `playground.EchoService/Echo`, `/Count`, `/Collect`, and `/Chat` |
| Socket.IO                     | `http://127.0.0.1:4780/` (path `/socket.io`)        | A `welcome` event, then `echo` events echoed back and acknowledged                          |
| MQTT                          | `mqtt://127.0.0.1:4782`                             | Anonymous broker; subscribe to `playground/#` and publish to `playground/echo`              |
| MQTT over WebSocket           | `ws://127.0.0.1:4780/mqtt`                          | The same broker over WebSocket                                                              |

Import **live-collection.json** in API Workbench for ten native WebSocket, live SSE, live NDJSON, gRPC, Socket.IO, and MQTT requests. The protocol selector opens the corresponding connection editor. For gRPC, choose Invoke; client-streaming Collect and bidirectional Chat support additional messages and Finish sending. The original collection.json retains its 14 HTTP examples, where SSE/NDJSON are intentionally buffered for comparison. The standalone smoke.mjs clients are also available.

## Run sample clients and checks

```sh
# Starts servers on temporary ports, checks every protocol, and shuts them down.
npm run samples:test

# Alternatively test a server already running on ports 4780/4781.
npm --prefix examples/protocol-playground test -- --running
```

`smoke.mjs` includes runnable WebSocket text/binary and gRPC unary/streaming clients. It tests real network round trips, GraphQL variables, authentication success/failure, redirects, compressed JSON, forms, HTTP error statuses, SSE, and NDJSON. No Electron session is required.

Try SSE live in a terminal:

```sh
curl -N 'http://127.0.0.1:4780/events?count=3&interval=100'
```

Try gRPC with an installed `grpcurl` (the proto is supplied because server reflection is not enabled):

```sh
grpcurl -plaintext -import-path examples/protocol-playground -proto playground.proto \
  -d '{"message":"Hello from Workbench"}' 127.0.0.1:4781 playground.EchoService/Echo

grpcurl -plaintext -import-path examples/protocol-playground -proto playground.proto \
  -d '{"count":3}' 127.0.0.1:4781 playground.EchoService/Count
```

SSE/NDJSON and gRPC Count allow at most 20 events. Streams clean up when disconnected. Request and WebSocket message bodies are limited to 1 MiB. The sample HTTP endpoints are plain HTTP, and gRPC uses an insecure loopback listener; these fixtures are intended for local testing.
