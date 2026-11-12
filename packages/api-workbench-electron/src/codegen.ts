import { HTTPSnippet, availableTargets, type HarRequest, type TargetId } from 'httpsnippet';
import { stringify as yaml } from 'yaml';
import type {
  CodegenInput,
  CodegenResult,
  CodegenTarget,
} from '@techieutils/api-workbench-common/types';
const custom: CodegenTarget[] = [
  {
    id: 'cpp',
    label: 'C++',
    extension: '.cpp',
    clients: [
      { id: 'libcurl', label: 'libcurl' },
      { id: 'cpr', label: 'CPR' },
    ],
  },
  {
    id: 'perl',
    label: 'Perl',
    extension: '.pl',
    clients: [
      { id: 'http-tiny', label: 'HTTP::Tiny' },
      { id: 'lwp', label: 'LWP::UserAgent' },
    ],
  },
  {
    id: 'ansible',
    label: 'Ansible',
    extension: '.yaml',
    clients: [{ id: 'uri', label: 'ansible.builtin.uri' }],
  },
  {
    id: 'terraform',
    label: 'Terraform',
    extension: '.tf',
    clients: [
      { id: 'http', label: 'HTTP provider (GET / HEAD / POST)' },
      { id: 'curl', label: 'terraform_data + cURL' },
    ],
  },
  {
    id: 'cmd',
    label: 'Windows CMD',
    extension: '.cmd',
    clients: [{ id: 'curl', label: 'curl.exe (PowerShell argument bridge)' }],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    extension: '.ts',
    clients: [
      { id: 'fetch', label: 'Fetch' },
      { id: 'axios', label: 'Axios' },
    ],
  },
];
export function codegenTargets(): CodegenTarget[] {
  const targets: CodegenTarget[] = availableTargets().map((target) => ({
    id: target.key,
    label: target.key === 'csharp' ? 'C# / .NET' : target.title,
    extension: target.extname || '.http',
    clients: target.clients.map((client) => ({ id: client.key, label: client.title })),
  }));
  targets
    .find((target) => target.id === 'node')!
    .clients.push(
      { id: 'native-fetch', label: 'Native Fetch (Node 18+)' },
      { id: 'got', label: 'Got' },
      { id: 'undici', label: 'Undici' },
    );
  return [...targets, ...custom].sort((a, b) => a.label.localeCompare(b.label));
}
const json = (value: unknown) => JSON.stringify(value);
const single = (value: string) => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const shell = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const hcl = (value: string) =>
  json(value)
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');
function prepare(input: CodegenInput): {
  headers: Record<string, string>;
  body: string;
  notes: string[];
} {
  const headers = { ...input.headers };
  const notes: string[] = [];
  Object.keys(headers)
    .filter((key) => key.toLowerCase() === 'content-length')
    .forEach((key) => delete headers[key]);
  const removeType = () =>
    Object.keys(headers)
      .filter((key) => /^(content-type|content-length)$/i.test(key))
      .forEach((key) => delete headers[key]);
  let body = input.body;
  if (input.bodyType === 'none' || ['GET', 'HEAD'].includes(input.method)) body = '';
  else if (input.bodyType === 'x-www-form-urlencoded') {
    removeType();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const params = new URLSearchParams();
    input.fields.forEach((field) => params.append(field.name, field.value));
    body = params.toString();
  } else if (input.bodyType === 'form-data') {
    removeType();
    let boundary = 'APIWorkbenchBoundary';
    while (input.fields.some((field) => field.value.includes(boundary))) boundary += 'X';
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    const disposition = (value: string) => value.replace(/[\r\n]/g, '').replace(/"/g, '%22');
    body =
      input.fields
        .map(
          (field) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${disposition(field.name)}"${field.fileName ? `; filename="${disposition(field.fileName)}"\r\nContent-Type: application/octet-stream` : ''}\r\n\r\n${field.fileName ? `<FILE_CONTENTS:${field.fileName}>` : field.value}\r\n`,
        )
        .join('') + `--${boundary}--\r\n`;
    if (input.fields.some((field) => field.fileName))
      notes.push(
        'File bytes are not embedded. Replace <FILE_CONTENTS:filename> with file contents, or use the cURL adapter for file upload arguments.',
      );
    notes.push(
      'Multipart fields are represented as an explicit MIME body to preserve duplicate keys across libraries.',
    );
  } else if (input.bodyType === 'binary') {
    removeType();
    headers['Content-Type'] = 'application/octet-stream';
    body = `<BINARY_CONTENTS:${input.binaryName || 'upload.bin'}>`;
    notes.push(
      'Replace the binary content placeholder with bytes read from your file, or use cURL for --data-binary @file.',
    );
  }
  return { headers, body, notes };
}
function curl(input: CodegenInput, headers: Record<string, string>, body: string): string {
  const upload =
    !['GET', 'HEAD'].includes(input.method) && ['binary', 'form-data'].includes(input.bodyType);
  const args = ['curl', '--request ' + shell(input.method), '--url ' + shell(input.url)];
  for (const [key, value] of Object.entries(headers))
    if (!upload || !/^content-(type|length)$/i.test(key))
      args.push('--header ' + shell(`${key}: ${value}`));
  if (upload && input.bodyType === 'form-data')
    input.fields.forEach((field) =>
      args.push(
        (field.fileName ? '--form ' : '--form-string ') +
          shell(`${field.name}=${field.fileName ? '@' + field.fileName : field.value}`),
      ),
    );
  else if (upload) args.push('--data-binary ' + shell('@' + (input.binaryName || 'upload.bin')));
  else if (body) args.push('--data-raw ' + shell(body));
  return args.join(' \\\n  ') + '\n';
}
export function generateCode(
  input: CodegenInput,
  targetId: string,
  clientId: string,
): CodegenResult {
  const target = codegenTargets().find((target) => target.id === targetId);
  if (!target || !target.clients.some((client) => client.id === clientId))
    throw new Error('Choose an available language and library.');
  if (!input || typeof input.url !== 'string' || !Array.isArray(input.fields))
    throw new Error('Invalid code generation request.');
  const { headers, body, notes } = prepare(input);
  let output: string | false | string[];
  const headerLines = Object.entries(headers);
  if (targetId === 'shell' && clientId === 'curl') {
    output = curl(input, headers, body);
    // cURL reads local files instead of embedding their contents.
    if (['form-data', 'binary'].includes(input.bodyType)) {
      notes.splice(0, notes.length);
      notes.push(
        'File names are relative to the directory where you run cURL. Update them to your local file paths.',
      );
    }
  } else if (targetId === 'ansible') {
    output = yaml([
      {
        name: 'Call API',
        hosts: 'localhost',
        gather_facts: false,
        tasks: [
          {
            name: 'Send request',
            'ansible.builtin.uri': {
              url: input.url,
              method: input.method,
              headers,
              ...(body ? { body, body_format: 'raw' } : {}),
              return_content: true,
              status_code: [200, 201, 202, 204],
            },
            register: 'api_response',
          },
          { name: 'Show response', 'ansible.builtin.debug': { var: 'api_response.content' } },
        ],
      },
    ]);
    notes.push('Adjust status_code to the successful responses your API returns.');
  } else if (targetId === 'terraform') {
    if (clientId === 'http') {
      if (!['GET', 'HEAD', 'POST'].includes(input.method))
        throw new Error(
          'The Terraform HTTP provider supports GET, HEAD, and POST. Choose terraform_data + cURL for this method.',
        );
      output = `terraform {\n  required_providers {\n    http = {\n      source = "hashicorp/http"\n    }\n  }\n}\n\ndata "http" "api" {\n  url = ${hcl(input.url)}\n  method = ${hcl(input.method)}\n  request_headers = {\n${headerLines.map(([key, value]) => `    ${hcl(key)} = ${hcl(value)}`).join('\n')}\n  }\n${body ? `  request_body = ${hcl(body)}\n` : ''}}\n\noutput "response_body" {\n  value = data.http.api.response_body\n}\n`;
      notes.push(
        'Terraform reads HTTP data sources during plan/apply. Request data and responses may be stored in Terraform state.',
      );
    } else {
      output = `resource "terraform_data" "api" {\n  provisioner "local-exec" {\n    command = ${hcl(curl(input, headers, body))}\n    interpreter = ["/bin/sh", "-c"]\n  }\n}\n`;
      notes.push(
        'Requires Terraform 1.4+, a POSIX shell, and cURL. Runs on resource creation; replace the resource to repeat the request.',
      );
    }
  } else if (targetId === 'perl') {
    const perlHeaders = headerLines
      .map(([key, value]) => `    ${single(key)} => ${single(value)}`)
      .join(',\n');
    output =
      clientId === 'http-tiny'
        ? `use strict;\nuse warnings;\nuse HTTP::Tiny;\n\nmy $response = HTTP::Tiny->new->request(${single(input.method)}, ${single(input.url)}, {\n  headers => {\n${perlHeaders}\n  },\n  content => ${single(body)}\n});\nprint $response->{content};\n`
        : `use strict;\nuse warnings;\nuse LWP::UserAgent;\nuse HTTP::Request;\n\nmy $request = HTTP::Request->new(${single(input.method)} => ${single(input.url)});\n${headerLines.map(([key, value]) => `$request->header(${single(key)} => ${single(value)});`).join('\n')}\n$request->content(${single(body)});\nmy $response = LWP::UserAgent->new->request($request);\nprint $response->decoded_content;\n`;
  } else if (targetId === 'cpp' && clientId === 'cpr') {
    const method = (
      {
        GET: 'Get',
        HEAD: 'Head',
        POST: 'Post',
        PUT: 'Put',
        PATCH: 'Patch',
        DELETE: 'Delete',
        OPTIONS: 'Options',
      } as Record<string, string>
    )[input.method];
    if (!method) throw new Error('Unsupported method for CPR.');
    output = `#include <cpr/cpr.h>\n#include <iostream>\n\nint main() {\n  cpr::Session session;\n  session.SetUrl(cpr::Url{${json(input.url)}});\n  session.SetHeader(cpr::Header{${headerLines.map(([key, value]) => `{${json(key)}, ${json(value)}}`).join(', ')}});\n${body ? `  session.SetBody(cpr::Body{${json(body)}});\n` : ''}  auto response = session.${method}();\n  std::cout << response.text << std::endl;\n}\n`;
  } else if (targetId === 'cmd') {
    const ps = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const args = [
      '--request',
      input.method,
      '--url',
      input.url,
      ...headerLines.flatMap(([key, value]) => ['--header', `${key}: ${value}`]),
      ...(body ? ['--data-raw', body] : []),
    ];
    const script = `& curl.exe @(${args.map(ps).join(', ')})`;
    output = `@echo off\r\nREM curl.exe arguments are passed through PowerShell to preserve CMD quoting.\r\nREM ${input.method} ${input.url.replace(/[\r\n]/g, '')}\r\npowershell.exe -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}\r\n`;
    notes.push(
      'Run as a .cmd file. Requires Windows PowerShell and curl.exe; the encoded command preserves quotes, percent signs, and multiline bodies.',
    );
  } else if (targetId === 'node' && ['native-fetch', 'got', 'undici'].includes(clientId)) {
    const options = { method: input.method, headers, ...(body ? { body } : {}) };
    if (clientId === 'got')
      output = `import got from 'got';\n\nconst response = await got(${json(input.url)}, ${JSON.stringify(options, null, 2)});\nconsole.log(response.body);\n`;
    else
      output = `${clientId === 'undici' ? "import { fetch } from 'undici';\n\n" : '// Node.js 18+ (ES module)\n'}const response = await fetch(${json(input.url)}, ${JSON.stringify(options, null, 2)});\nconsole.log(await response.text());\n`;
  } else {
    const normalizedURL = input.url.replace(/'/g, '%27').replace(/`/g, '%60');
    // Treat explicit MIME bodies as raw text so converters cannot collapse duplicate form keys.
    const har: HarRequest = {
      method: input.method,
      url: normalizedURL,
      httpVersion: 'HTTP/1.1',
      headers: headerLines.map(([name, value]) => ({ name, value })),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: -1,
      postData: { mimeType: 'text/plain', text: body },
    };
    const engineTarget =
      targetId === 'cpp' ? 'c' : targetId === 'typescript' ? 'javascript' : targetId;
    output = new HTTPSnippet(har).convert(engineTarget as TargetId, clientId);
  }
  if (!output || Array.isArray(output))
    throw new Error('This adapter could not generate a snippet.');
  if (targetId === 'node' && clientId === 'request')
    notes.push(
      'The Request package is deprecated; prefer Native Fetch, Axios, Got, or Undici for new projects.',
    );
  const installs: Record<string, string> = {
    'node:axios': 'npm install axios',
    'node:fetch': 'npm install node-fetch',
    'node:got': 'npm install got',
    'node:undici': 'npm install undici',
    'node:request': 'npm install request',
    'node:unirest': 'npm install unirest',
    'javascript:axios': 'npm install axios',
    'typescript:axios': 'npm install axios',
    'javascript:jquery': 'npm install jquery',
    'python:requests': 'python -m pip install requests',
    'php:guzzle': 'composer require guzzlehttp/guzzle',
    'ruby:faraday': 'gem install faraday',
    'perl:lwp': 'cpan LWP::UserAgent',
    'java:okhttp': 'Add com.squareup.okhttp3:okhttp to your Gradle/Maven dependencies.',
    'kotlin:okhttp': 'Add com.squareup.okhttp3:okhttp to your Gradle dependencies.',
    'csharp:restsharp': 'dotnet add package RestSharp',
    'c:libcurl': 'Link against libcurl (-lcurl).',
    'cpp:libcurl': 'Link against libcurl (-lcurl).',
    'cpp:cpr': 'Install CPR and link cpr::cpr in CMake.',
  };
  const install = installs[`${targetId}:${clientId}`];
  if (install) notes.push(install);
  notes.push(
    'Install the selected library if needed. Clients use their own timeout and redirect defaults. Snippets are never executed by API Workbench.',
  );
  return { code: output, filename: `request${target.extension}`, notes };
}
