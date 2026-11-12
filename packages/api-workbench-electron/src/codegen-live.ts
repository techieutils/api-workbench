import type {
  CodegenInput,
  CodegenResult,
  CodegenTarget,
} from '@techieutils/api-workbench-common/types';
import { describeMethod } from './protocols';
import { defaultMQTT, defaultSocketIO } from '@techieutils/api-workbench-common/protocol-config';

/**
 * Code for live connections: WebSocket, Server-Sent Events, NDJSON streams, gRPC, Socket.IO, and
 * MQTT. Each
 * protocol has its own languages and libraries; snippets connect, send the request's message,
 * and print what arrives. Nothing here is executed.
 */
type LiveProtocol = 'websocket' | 'sse' | 'ndjson' | 'grpc' | 'socketio' | 'mqtt';

const TARGETS: Record<LiveProtocol, CodegenTarget[]> = {
  websocket: [
    {
      id: 'javascript',
      label: 'JavaScript',
      extension: '.js',
      clients: [{ id: 'websocket', label: 'WebSocket (browser)' }],
    },
    { id: 'node', label: 'Node.js', extension: '.mjs', clients: [{ id: 'ws', label: 'ws' }] },
    {
      id: 'python',
      label: 'Python',
      extension: '.py',
      clients: [{ id: 'websockets', label: 'websockets' }],
    },
    {
      id: 'go',
      label: 'Go',
      extension: '.go',
      clients: [{ id: 'gorilla', label: 'gorilla/websocket' }],
    },
    {
      id: 'shell',
      label: 'Shell',
      extension: '.sh',
      clients: [{ id: 'websocat', label: 'websocat' }],
    },
  ],
  sse: [
    { id: 'shell', label: 'Shell', extension: '.sh', clients: [{ id: 'curl', label: 'cURL' }] },
    {
      id: 'javascript',
      label: 'JavaScript',
      extension: '.js',
      clients: [
        { id: 'eventsource', label: 'EventSource (browser)' },
        { id: 'fetch', label: 'Fetch stream' },
      ],
    },
    {
      id: 'node',
      label: 'Node.js',
      extension: '.mjs',
      clients: [{ id: 'fetch', label: 'Native Fetch (Node 18+)' }],
    },
    {
      id: 'python',
      label: 'Python',
      extension: '.py',
      clients: [{ id: 'requests', label: 'Requests' }],
    },
    { id: 'go', label: 'Go', extension: '.go', clients: [{ id: 'native', label: 'net/http' }] },
  ],
  ndjson: [
    {
      id: 'shell',
      label: 'Shell',
      extension: '.sh',
      clients: [{ id: 'curl', label: 'cURL + jq' }],
    },
    {
      id: 'javascript',
      label: 'JavaScript',
      extension: '.js',
      clients: [{ id: 'fetch', label: 'Fetch stream' }],
    },
    {
      id: 'node',
      label: 'Node.js',
      extension: '.mjs',
      clients: [{ id: 'fetch', label: 'Native Fetch (Node 18+)' }],
    },
    {
      id: 'python',
      label: 'Python',
      extension: '.py',
      clients: [{ id: 'requests', label: 'Requests' }],
    },
    { id: 'go', label: 'Go', extension: '.go', clients: [{ id: 'native', label: 'net/http' }] },
  ],
  grpc: [
    {
      id: 'shell',
      label: 'Shell',
      extension: '.sh',
      clients: [{ id: 'grpcurl', label: 'grpcurl' }],
    },
    {
      id: 'node',
      label: 'Node.js',
      extension: '.mjs',
      clients: [{ id: 'grpc-js', label: '@grpc/grpc-js' }],
    },
    {
      id: 'python',
      label: 'Python',
      extension: '.py',
      clients: [{ id: 'grpcio', label: 'grpcio' }],
    },
  ],
  socketio: [
    {
      id: 'node',
      label: 'Node.js',
      extension: '.mjs',
      clients: [{ id: 'socket.io-client', label: 'socket.io-client' }],
    },
    {
      id: 'javascript',
      label: 'JavaScript',
      extension: '.js',
      clients: [{ id: 'socket.io-client', label: 'socket.io-client (browser)' }],
    },
    {
      id: 'python',
      label: 'Python',
      extension: '.py',
      clients: [{ id: 'python-socketio', label: 'python-socketio' }],
    },
  ],
  mqtt: [
    {
      id: 'shell',
      label: 'Shell',
      extension: '.sh',
      clients: [{ id: 'mosquitto', label: 'mosquitto_pub / mosquitto_sub' }],
    },
    {
      id: 'node',
      label: 'Node.js',
      extension: '.mjs',
      clients: [{ id: 'mqtt', label: 'MQTT.js' }],
    },
    {
      id: 'python',
      label: 'Python',
      extension: '.py',
      clients: [{ id: 'paho', label: 'paho-mqtt' }],
    },
  ],
};
export const isLiveProtocol = (value: unknown): value is LiveProtocol =>
  typeof value === 'string' && value in TARGETS;
export const liveTargets = (protocol: LiveProtocol): CodegenTarget[] => TARGETS[protocol];

const json = (value: unknown) => JSON.stringify(value);
const shell = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const py = (value: string) => json(value);
const pyDict = (headers: Record<string, string>) =>
  `{${Object.entries(headers)
    .map(([key, value]) => `${py(key)}: ${py(value)}`)
    .join(', ')}}`;
const goString = (value: string) => json(value);
/** Text as an indented JSON literal for JavaScript, or the original text when it is not JSON. */
function jsMessage(message: string): string {
  try {
    return `JSON.stringify(${JSON.stringify(JSON.parse(message), null, 2).replace(/\n/g, '\n  ')})`;
  } catch {
    return json(message);
  }
}
function pyMessage(message: string): string {
  try {
    JSON.parse(message);
    return `json.dumps(${pyLiteral(JSON.parse(message))})`;
  } catch {
    return py(message);
  }
}
/** A JSON value as a Python literal (True/False/None instead of true/false/null). */
function pyLiteral(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(', ')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${py(key)}: ${pyLiteral(item)}`)
      .join(', ')}}`;
  return json(value);
}

function websocket(input: CodegenInput, target: string, notes: string[]): string {
  const { url, headers } = input;
  const message = input.body;
  const binary = input.binary === true;
  if (target === 'javascript') {
    if (Object.keys(headers).length)
      notes.push(
        'Browsers cannot set headers on a WebSocket handshake; send credentials in the URL or the first message instead, or use the Node.js client.',
      );
    return `const socket = new WebSocket(${json(url)});
${binary ? "socket.binaryType = 'arraybuffer';\n" : ''}
socket.addEventListener('open', () => {
${message ? `  socket.send(${binary ? `Uint8Array.from(atob(${json(message)}), (char) => char.charCodeAt(0))` : jsMessage(message)});\n` : ''}});
socket.addEventListener('message', (event) => console.log('Received:', event.data));
socket.addEventListener('close', (event) => console.log('Closed:', event.code, event.reason));
socket.addEventListener('error', (event) => console.error('WebSocket error', event));
`;
  }
  if (target === 'node') {
    notes.push('Install the client with npm install ws.');
    return `import WebSocket from 'ws';

const socket = new WebSocket(${json(url)}, {
  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')},
});

socket.on('open', () => {
${message ? `  socket.send(${binary ? `Buffer.from(${json(message)}, 'base64')` : jsMessage(message)});\n` : ''}});
socket.on('message', (data, isBinary) => console.log('Received:', isBinary ? data : data.toString()));
socket.on('close', (code, reason) => console.log('Closed:', code, reason.toString()));
socket.on('error', (error) => console.error(error));
`;
  }
  if (target === 'python') {
    notes.push('Install the client with pip install websockets (version 13 or later).');
    return `import asyncio
${binary ? 'import base64\n' : ''}${!binary && pyMessage(message).startsWith('json.') ? 'import json\n' : ''}
import websockets


async def main():
    async with websockets.connect(
        ${py(url)},
        additional_headers=${pyDict(headers)},
    ) as socket:
${message ? `        await socket.send(${binary ? `base64.b64decode(${py(message)})` : pyMessage(message)})\n` : ''}        async for message in socket:
            print("Received:", message)


asyncio.run(main())
`;
  }
  if (target === 'go') {
    notes.push('Get the client with go get github.com/gorilla/websocket.');
    return `package main

import (
${binary ? '\t"encoding/base64"\n' : ''}\t"log"
\t"net/http"

\t"github.com/gorilla/websocket"
)

func main() {
\theader := http.Header{}
${Object.entries(headers)
  .map(([key, value]) => `\theader.Set(${goString(key)}, ${goString(value)})`)
  .join('\n')}
\tconn, _, err := websocket.DefaultDialer.Dial(${goString(url)}, header)
\tif err != nil {
\t\tlog.Fatal(err)
\t}
\tdefer conn.Close()
${
  message
    ? binary
      ? `\tpayload, _ := base64.StdEncoding.DecodeString(${goString(message)})
\tif err := conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
\t\tlog.Fatal(err)
\t}
`
      : `\tif err := conn.WriteMessage(websocket.TextMessage, []byte(${goString(message)})); err != nil {
\t\tlog.Fatal(err)
\t}
`
    : ''
}\tfor {
\t\t_, data, err := conn.ReadMessage()
\t\tif err != nil {
\t\t\tlog.Println("Closed:", err)
\t\t\treturn
\t\t}
\t\tlog.Printf("Received: %s", data)
\t}
}
`;
  }
  notes.push('Install websocat from https://github.com/vi/websocat.');
  const args = [
    'websocat',
    ...Object.entries(headers).map(([key, value]) => `-H ${shell(`${key}: ${value}`)}`),
    ...(binary ? ['--binary'] : []),
    shell(url),
  ];
  return message
    ? `${binary ? `printf %s ${shell(message)} | base64 --decode` : `printf '%s\\n' ${shell(message)}`} | ${args.join(' \\\n  ')}\n`
    : `${args.join(' \\\n  ')}\n`;
}

/** SSE and NDJSON: an HTTP GET whose body arrives as a stream of events or lines. */
function stream(
  input: CodegenInput,
  target: string,
  client: string,
  kind: 'sse' | 'ndjson',
  notes: string[],
): string {
  const headers = {
    Accept: kind === 'sse' ? 'text/event-stream' : 'application/x-ndjson',
    ...input.headers,
  };
  const { url } = input;
  if (target === 'shell') {
    const args = [
      'curl',
      '--no-buffer',
      ...Object.entries(headers).map(([key, value]) => `--header ${shell(`${key}: ${value}`)}`),
      shell(url),
    ];
    if (kind === 'sse') return `${args.join(' \\\n  ')}\n`;
    notes.push('jq prints each JSON line as it arrives; remove the pipe to see the raw stream.');
    return `${args.join(' \\\n  ')} \\\n  | jq --unbuffered .\n`;
  }
  if (target === 'javascript' && client === 'eventsource') {
    if (Object.keys(input.headers).length)
      notes.push(
        'EventSource cannot send custom headers; use the Fetch stream client to send them.',
      );
    return `const events = new EventSource(${json(url)});

events.onmessage = (event) => console.log('Message:', event.data);
// Named events: events.addEventListener('update', (event) => console.log(event.data));
events.onerror = () => console.error('Connection lost; EventSource reconnects automatically.');
`;
  }
  if (target === 'javascript' || target === 'node') {
    const parse =
      kind === 'sse'
        ? `  // Events are separated by a blank line; each has event:, data:, and id: fields.
  let boundary;
  while ((boundary = buffer.search(/\\r?\\n\\r?\\n/)) >= 0) {
    const block = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary).replace(/^\\r?\\n\\r?\\n/, '');
    const event = { event: 'message', data: [] };
    for (const line of block.split(/\\r?\\n/)) {
      const [field, ...rest] = line.split(':');
      const value = rest.join(':').replace(/^ /, '');
      if (field === 'data') event.data.push(value);
      else if (field === 'event' || field === 'id') event[field] = value;
    }
    if (event.data.length) console.log(event.event, event.data.join('\\n'));
  }`
        : `  // Each complete line is one JSON value.
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) console.log(JSON.parse(line));
  }`;
    return `const response = await fetch(${json(url)}, {
  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')},
});
if (!response.ok) throw new Error(\`HTTP \${response.status}\`);

const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
let buffer = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
${parse}
}
`;
  }
  if (target === 'python') {
    notes.push('Install the client with pip install requests.');
    return kind === 'sse'
      ? `import requests

headers = ${pyDict(headers)}

with requests.get(${py(url)}, headers=headers, stream=True) as response:
    response.raise_for_status()
    event, data = "message", []
    for line in response.iter_lines(decode_unicode=True):
        if line == "":
            if data:
                print(event, "\\n".join(data))
            event, data = "message", []
        elif line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
        elif line.startswith("event:"):
            event = line[6:].strip()
`
      : `import json

import requests

headers = ${pyDict(headers)}

with requests.get(${py(url)}, headers=headers, stream=True) as response:
    response.raise_for_status()
    for line in response.iter_lines(decode_unicode=True):
        if line:
            print(json.loads(line))
`;
  }
  return `package main

import (
\t"bufio"
${kind === 'ndjson' ? '\t"encoding/json"\n' : ''}\t"fmt"
\t"log"
\t"net/http"
${kind === 'sse' ? '\t"strings"\n' : ''})

func main() {
\treq, err := http.NewRequest("GET", ${goString(url)}, nil)
\tif err != nil {
\t\tlog.Fatal(err)
\t}
${Object.entries(headers)
  .map(([key, value]) => `\treq.Header.Set(${goString(key)}, ${goString(value)})`)
  .join('\n')}
\tres, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tlog.Fatal(err)
\t}
\tdefer res.Body.Close()

\tscanner := bufio.NewScanner(res.Body)
\tscanner.Buffer(make([]byte, 64*1024), 10*1024*1024)
${
  kind === 'sse'
    ? `\tevent, data := "message", []string{}
\tfor scanner.Scan() {
\t\tline := scanner.Text()
\t\tswitch {
\t\tcase line == "":
\t\t\tif len(data) > 0 {
\t\t\t\tfmt.Println(event, strings.Join(data, "\\n"))
\t\t\t}
\t\t\tevent, data = "message", nil
\t\tcase strings.HasPrefix(line, "data:"):
\t\t\tdata = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
\t\tcase strings.HasPrefix(line, "event:"):
\t\t\tevent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
\t\t}
\t}
`
    : `\tfor scanner.Scan() {
\t\tif len(scanner.Bytes()) == 0 {
\t\t\tcontinue
\t\t}
\t\tvar value any
\t\tif err := json.Unmarshal(scanner.Bytes(), &value); err != nil {
\t\t\tlog.Fatal(err)
\t\t}
\t\tfmt.Println(value)
\t}
`
}\tif err := scanner.Err(); err != nil {
\t\tlog.Fatal(err)
\t}
}
`;
}

function grpc(input: CodegenInput, target: string, notes: string[]): string {
  const config = input.grpc;
  if (!config?.method) throw new Error('Choose a gRPC method in the Schema tab first.');
  const path = config.method.replace(/^\//, '');
  const [service, method] = [
    path.slice(0, path.lastIndexOf('/')),
    path.slice(path.lastIndexOf('/') + 1),
  ];
  if (!service || !method)
    throw new Error('The gRPC method should look like /package.Service/Method.');
  let kind: { requestStream: boolean; responseStream: boolean; requestType?: string } = {
    requestStream: false,
    responseStream: false,
  };
  try {
    kind = describeMethod(config.proto, path) ?? kind;
  } catch {
    notes.push('The schema could not be read, so the call is shown as unary.');
  }
  const message = input.body.trim() || '{}';
  const metadata = input.headers;
  const protoFile = 'service.proto';
  notes.push(`Save the Schema tab's definition as ${protoFile} next to this code.`);
  if (target === 'shell') {
    notes.push('Install grpcurl from https://github.com/fullstorydev/grpcurl.');
    const args = [
      'grpcurl',
      ...(config.tls ? [] : ['-plaintext']),
      `-proto ${protoFile}`,
      ...Object.entries(metadata).map(([key, value]) => `-H ${shell(`${key}: ${value}`)}`),
      `-d ${shell(message)}`,
      shell(input.url),
      shell(path),
    ];
    if (kind.requestStream)
      notes.push(
        'For a client stream, pass several JSON messages to -d @ on standard input, one after another.',
      );
    return `${args.join(' \\\n  ')}\n`;
  }
  if (target === 'node') {
    notes.push('Install the client with npm install @grpc/grpc-js @grpc/proto-loader.');
    const packagePath = service.split('.');
    const serviceName = packagePath.pop()!;
    const lookup = ['proto', ...packagePath]
      .map((part, index) => (index ? `[${json(part)}]` : part))
      .join('');
    const methodName = method[0].toLowerCase() + method.slice(1);
    const call =
      kind.requestStream && kind.responseStream
        ? `const call = client.${methodName}(metadata);
call.on('data', (reply) => console.log('Received:', reply));
call.on('end', () => console.log('Done'));
call.on('error', (error) => console.error(error.code, error.details));
call.write(${message});
call.end();`
        : kind.requestStream
          ? `const call = client.${methodName}(metadata, (error, reply) => {
  if (error) return console.error(error.code, error.details);
  console.log('Reply:', reply);
});
call.write(${message});
call.end();`
          : kind.responseStream
            ? `const call = client.${methodName}(${message}, metadata);
call.on('data', (reply) => console.log('Received:', reply));
call.on('end', () => console.log('Done'));
call.on('error', (error) => console.error(error.code, error.details));`
            : `client.${methodName}(${message}, metadata, (error, reply) => {
  if (error) return console.error(error.code, error.details);
  console.log('Reply:', reply);
});`;
    return `import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';

const definition = loader.loadSync(${json(protoFile)}, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const proto = grpc.loadPackageDefinition(definition);
const Service = ${lookup}[${json(serviceName)}];
const client = new Service(${json(input.url)}, ${config.tls ? 'grpc.credentials.createSsl()' : 'grpc.credentials.createInsecure()'});

const metadata = new grpc.Metadata();
${Object.entries(metadata)
  .map(([key, value]) => `metadata.add(${json(key)}, ${json(value)});`)
  .join('\n')}

${call}
`;
  }
  notes.push(
    `Generate the Python modules first: python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. ${protoFile} (pip install grpcio grpcio-tools).`,
  );
  const serviceName = service.split('.').pop()!;
  const module = protoFile.replace(/\.proto$/, '');
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(message);
  } catch {
    notes.push('The message is not valid JSON; replace the placeholder fields.');
  }
  const requestType = kind.requestType || 'Request';
  if (!kind.requestType)
    notes.push(
      `Replace ${module}_pb2.${requestType} with the method's request message type from the schema.`,
    );
  const build = `json_format.ParseDict(${pyLiteral(parsed)}, ${module}_pb2.${requestType}())`;
  const metadataList = `[${Object.entries(metadata)
    .map(([key, value]) => `(${py(key.toLowerCase())}, ${py(value)})`)
    .join(', ')}]`;
  const callLine = kind.requestStream ? `iter([${build}])` : build;
  const result = kind.responseStream
    ? `    for reply in stub.${method}(${callLine}, metadata=metadata):\n        print("Received:", reply)`
    : `    reply = stub.${method}(${callLine}, metadata=metadata)\n    print("Reply:", reply)`;
  return `import grpc
from google.protobuf import json_format

import ${module}_pb2
import ${module}_pb2_grpc

metadata = ${metadataList}

with grpc.${config.tls ? `secure_channel(${py(input.url)}, grpc.ssl_channel_credentials())` : `insecure_channel(${py(input.url)})`} as channel:
    stub = ${module}_pb2_grpc.${serviceName}Stub(channel)
${result}
`;
}

/** Socket.IO: connect to a namespace, emit the message as the configured event, log every event. */
function socketio(input: CodegenInput, target: string, notes: string[]): string {
  const config = input.socketio ?? defaultSocketIO();
  const url = new URL(input.url);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  const address = url.toString();
  const headers = input.headers;
  const message = input.body;
  let value: unknown = message;
  try {
    value = message.trim() ? (JSON.parse(message) as unknown) : message;
  } catch {
    /* Text that is not JSON is emitted as a string. */
  }
  const jsValue = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
  if (target === 'python') {
    notes.push('Install the client with pip install "python-socketio[client]".');
    return `import socketio

sio = socketio.Client()


@sio.event
def connect():
    print("Connected:", sio.sid)
${
  message
    ? config.ack
      ? `    print("Acknowledged:", sio.call(${py(config.event)}, ${pyLiteral(value)}))\n`
      : `    sio.emit(${py(config.event)}, ${pyLiteral(value)})\n`
    : ''
}

@sio.on("*")
def any_event(event, *args):
    print("Received:", event, args)


@sio.event
def disconnect(reason=None):
    print("Disconnected:", reason)


sio.connect(
    ${py(address)},
    headers=${pyDict(headers)},
    socketio_path=${py(config.path)},
    transports=["websocket"],
)
sio.wait()
`;
  }
  const browser = target === 'javascript';
  if (browser && Object.keys(headers).length)
    notes.push(
      'Browsers cannot set headers on a WebSocket handshake; pass credentials with the auth option instead, or use the Node.js client.',
    );
  notes.push(
    browser
      ? 'Install the client with npm install socket.io-client, or load it from your Socket.IO server at /socket.io/socket.io.js.'
      : 'Install the client with npm install socket.io-client.',
  );
  const emit = message
    ? config.ack
      ? `  socket.timeout(10000).emit(${json(config.event)}, ${jsValue}, (error, ...reply) =>
    error ? console.error('No acknowledgement:', error) : console.log('Acknowledged:', ...reply),
  );\n`
      : `  socket.emit(${json(config.event)}, ${jsValue});\n`
    : '';
  return `import { io } from 'socket.io-client';

const socket = io(${json(address)}, {
  path: ${json(config.path)},
  transports: ['websocket'],${browser ? '' : `\n  extraHeaders: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')},`}
});

socket.on('connect', () => {
  console.log('Connected:', socket.id);
${emit}});
socket.onAny((event, ...args) => console.log('Received:', event, ...args));
socket.on('connect_error', (error) => console.error('Connection failed:', error.message));
socket.on('disconnect', (reason) => console.log('Disconnected:', reason));
`;
}

/** MQTT: subscribe to the enabled topic filters and publish the message to the configured topic. */
function mqttCode(input: CodegenInput, target: string, notes: string[]): string {
  const config = input.mqtt ?? defaultMQTT();
  const url = new URL(input.url);
  const message = input.body;
  const binary = input.binary === true;
  const subscriptions = config.subscriptions.filter((row) => row.enabled && row.topic);
  const publish = Boolean(message && config.topic);
  // Basic auth becomes the broker username and password, as when API Workbench connects.
  const authorization = Object.entries(input.headers).find(
    ([key]) => key.toLowerCase() === 'authorization',
  )?.[1];
  const basic = authorization ? /^Basic\s+(\S+)$/i.exec(authorization) : null;
  // Redacted code keeps placeholders where the username and password go.
  const decoded = !basic
    ? ''
    : basic[1] === '<REDACTED>'
      ? '<USERNAME>:<REDACTED>'
      : Buffer.from(basic[1], 'base64').toString('utf8');
  const username = basic ? decoded.split(':')[0] : '';
  const password = basic && decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : '';
  if (authorization && !basic)
    notes.push('Only Basic auth is included; brokers take a username and password.');
  if (target === 'node') {
    notes.push('Install the client with npm install mqtt.');
    const options = {
      protocolVersion: config.version,
      clean: config.cleanStart,
      keepalive: config.keepalive,
      ...(config.clientId ? { clientId: config.clientId } : {}),
      ...(basic ? { username, password } : {}),
    };
    return `import mqtt from 'mqtt';

const client = mqtt.connect(${json(url.toString())}, ${JSON.stringify(options, null, 2)});

client.on('connect', () => {
  console.log('Connected');
${subscriptions
  .map(
    (row) =>
      `  client.subscribe(${json(row.topic)}, { qos: ${row.qos} }, (error) => error && console.error(error));\n`,
  )
  .join('')}${
      publish
        ? `  client.publish(${json(config.topic)}, ${binary ? `Buffer.from(${json(message)}, 'base64')` : json(message)}, { qos: ${config.qos}, retain: ${config.retain} });\n`
        : ''
    }});
client.on('message', (topic, payload) => console.log('Received:', topic, payload.toString()));
client.on('error', (error) => console.error(error));
`;
  }
  if (target === 'python') {
    notes.push('Install the client with pip install paho-mqtt (version 2 or later).');
    const secure = url.protocol === 'mqtts:' || url.protocol === 'wss:';
    const websockets = url.protocol === 'ws:' || url.protocol === 'wss:';
    const port = Number(
      url.port ||
        (url.protocol === 'mqtt:' ? 1883 : url.protocol === 'mqtts:' ? 8883 : secure ? 443 : 80),
    );
    return `${binary ? 'import base64\n' : ''}import paho.mqtt.client as mqtt


def on_connect(client, userdata, flags, reason_code, properties):
    print("Connected:", reason_code)
${subscriptions.map((row) => `    client.subscribe(${py(row.topic)}, qos=${row.qos})\n`).join('')}${
      publish
        ? `    client.publish(${py(config.topic)}, ${binary ? `base64.b64decode(${py(message)})` : py(message)}, qos=${config.qos}, retain=${config.retain ? 'True' : 'False'})\n`
        : ''
    }

def on_message(client, userdata, message):
    print("Received:", message.topic, message.payload)


client = mqtt.Client(
    mqtt.CallbackAPIVersion.VERSION2,
    client_id=${py(config.clientId)},
    protocol=${config.version === 5 ? 'mqtt.MQTTv5' : 'mqtt.MQTTv311'},
    transport=${py(websockets ? 'websockets' : 'tcp')},
)
${websockets ? `client.ws_set_options(path=${py(url.pathname || '/')})\n` : ''}${secure ? 'client.tls_set()\n' : ''}${basic ? `client.username_pw_set(${py(username)}, ${py(password)})\n` : ''}client.on_connect = on_connect
client.on_message = on_message
client.connect(${py(url.hostname.replace(/^\[|\]$/g, ''))}, ${port}, keepalive=${config.keepalive})
client.loop_forever()
`;
  }
  notes.push('Install the Mosquitto clients from https://mosquitto.org/download/.');
  if (url.protocol === 'ws:' || url.protocol === 'wss:')
    notes.push('mosquitto_pub and mosquitto_sub need a broker URL with mqtt:// or mqtts://.');
  // mosquitto's -L takes the broker and one topic as a URL: mqtt://host:port/topic.
  const broker = `${url.protocol}//${url.host}`;
  const flags = [
    `-V ${config.version === 5 ? 'mqttv5' : 'mqttv311'}`,
    ...(config.clientId ? [`-i ${shell(config.clientId)}`] : []),
    ...(basic ? [`-u ${shell(username)}`, ...(password ? [`-P ${shell(password)}`] : [])] : []),
  ];
  const lines: string[] = [];
  if (publish) {
    const args = [
      'mosquitto_pub',
      `-L ${shell(`${broker}/${config.topic}`)}`,
      ...flags,
      `-q ${config.qos}`,
      ...(config.retain ? ['-r'] : []),
      binary ? '-s' : `-m ${shell(message)}`,
    ];
    lines.push(
      binary
        ? `printf %s ${shell(message)} | base64 --decode | ${args.join(' \\\n  ')}`
        : args.join(' \\\n  '),
    );
  }
  const subscription = subscriptions[0] ?? { topic: '#', qos: 0 };
  lines.push(
    [
      'mosquitto_sub',
      `-L ${shell(`${broker}/${subscription.topic}`)}`,
      ...flags,
      `-q ${subscription.qos}`,
      '-v',
    ].join(' \\\n  '),
  );
  if (subscriptions.length > 1)
    notes.push('mosquitto_sub -L takes one topic; repeat the command for each subscription.');
  return `${lines.join('\n\n')}\n`;
}

export function generateLiveCode(
  input: CodegenInput,
  targetId: string,
  clientId: string,
): CodegenResult {
  const protocol = input.protocol;
  if (!isLiveProtocol(protocol)) throw new Error('Unsupported protocol.');
  const target = TARGETS[protocol].find((item) => item.id === targetId);
  if (!target || !target.clients.some((client) => client.id === clientId))
    throw new Error('Choose an available language and library.');
  const notes: string[] = [];
  const code =
    protocol === 'websocket'
      ? websocket(input, targetId, notes)
      : protocol === 'grpc'
        ? grpc(input, targetId, notes)
        : protocol === 'socketio'
          ? socketio(input, targetId, notes)
          : protocol === 'mqtt'
            ? mqttCode(input, targetId, notes)
            : stream(input, targetId, clientId, protocol, notes);
  return { code, filename: `${protocol}${target.extension}`, notes };
}
