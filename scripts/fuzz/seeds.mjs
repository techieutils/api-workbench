// A small valid document of each format, which the fuzzer changes a little at a time.
const postman = JSON.stringify({
  info: {
    name: 'P',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Folder',
      item: [
        {
          name: 'Get',
          request: {
            method: 'POST',
            url: {
              raw: 'https://{{host}}/users/:id?x=1',
              host: ['{{host}}'],
              path: ['users', ':id'],
              query: [{ key: 'x', value: '1' }],
            },
            header: [{ key: 'A', value: 'b' }],
            body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] },
          },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }],
        },
      ],
    },
  ],
  variable: [{ key: 'host', value: 'api.example.com' }],
});
const insomnia = JSON.stringify({
  _type: 'export',
  __export_format: 4,
  resources: [
    { _id: 'wrk_1', _type: 'workspace', name: 'W' },
    { _id: 'fld_1', _type: 'request_group', parentId: 'wrk_1', name: 'F' },
    {
      _id: 'req_1',
      _type: 'request',
      parentId: 'fld_1',
      name: 'R',
      method: 'GET',
      url: 'https://x/{{ _.id }}',
      headers: [{ name: 'A', value: 'b' }],
      body: { mimeType: 'application/json', text: '{}' },
    },
    { _id: 'env_1', _type: 'environment', parentId: 'wrk_1', name: 'Base', data: { id: 1 } },
  ],
});
const hoppscotch = JSON.stringify([
  {
    v: 2,
    name: 'H',
    folders: [],
    requests: [
      {
        v: '1',
        name: 'r',
        method: 'GET',
        endpoint: 'https://x',
        params: [],
        headers: [],
        body: { contentType: null, body: null },
        auth: { authType: 'none' },
      },
    ],
  },
]);
const openapi = `openapi: 3.0.0
info: { title: T, version: '1' }
servers: [{ url: 'https://api.example.com/v1' }]
paths:
  /users/{id}:
    get:
      parameters: [{ name: id, in: path, required: true, schema: { type: string, pattern: '^[a-z]+$' } }]
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/U' } } } }
components:
  schemas:
    U: { type: object, properties: { name: { type: string } } }
`;
const swagger = JSON.stringify({
  swagger: '2.0',
  info: { title: 'S', version: '1' },
  host: 'x',
  basePath: '/v',
  paths: {
    '/a': {
      post: {
        parameters: [{ in: 'body', name: 'b', schema: { type: 'object' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
});
const har = JSON.stringify({
  log: {
    version: '1.2',
    entries: [
      {
        request: {
          method: 'POST',
          url: 'https://x/a?b=c',
          headers: [{ name: 'A', value: 'b' }],
          queryString: [],
          postData: { mimeType: 'application/json', text: '{}' },
        },
        response: { status: 200 },
      },
    ],
  },
});
const workbench = JSON.stringify({
  requests: [
    {
      id: 'r1',
      name: 'R',
      method: 'GET',
      url: 'https://x',
      folder: 'A/B',
      headers: [],
      params: [],
      body: '',
      auth: 'None',
      tests: 'status equals 200',
    },
  ],
  environments: [{ name: 'E', variables: [{ key: 'a', value: 'b', enabled: true }] }],
});
const bru = `meta {
  name: Get user
  type: http
  seq: 1
}

get {
  url: https://api.example.com/users/{{id}}
  body: json
  auth: bearer
}

headers {
  Accept: application/json
}

auth:bearer {
  token: {{token}}
}

body:json {
  {"a": 1}
}

tests {
  test("ok", function() {});
}
`;
const wsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:x" targetNamespace="urn:x" name="Svc">
  <message name="In"><part name="p" type="xsd:string"/></message>
  <portType name="PT"><operation name="Op"><input message="tns:In"/></operation></portType>
  <binding name="B" type="tns:PT"><soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Op"><soap:operation soapAction="urn:x#Op"/></operation></binding>
  <service name="Svc"><port name="P" binding="tns:B"><soap:address location="https://x/soap"/></port></service>
</definitions>`;
const http = `@host = https://api.example.com
### Get
# @name getUser
GET {{host}}/users/1?x=1
Authorization: Bearer {{token}}

###
POST {{host}}/upload
Content-Type: multipart/form-data; boundary=XYZ

--XYZ
Content-Disposition: form-data; name="f"; filename="a.png"

< ./a.png
--XYZ--

###
POST {{host}}/raw

<@ ./body.json
`;
const curl = `curl -X POST 'https://api.example.com/a?b=c' -H 'Content-Type: application/json' -H "Authorization: Bearer x" --data-raw '{"a":1}' -u user:pass --compressed -F 'f=@a.png' -b 'c=d'`;
const assertions = `status equals 200
header content-type contains json
json $.data[0].id equals 1
json $.data length > 0
body matches /a+!/
json $.data[*].name is-unique
cookie a equals b
time < 500`;
export const seeds = {
  importJSON: [postman, insomnia, hoppscotch, swagger, workbench, har],
  importYAML: [openapi],
  importBru: [bru],
  importWSDL: [wsdl],
  importHAR: [har],
  importHTTP: [http],
  parseText: [curl, http],
  curl: [curl],
  httpFile: [http],
  httpFileReferences: [http],
  vscodeHttpFile: [http],
  analyzeSpec: [openapi, swagger],
  assertions: [assertions],
  jsonPathAt: [JSON.stringify(JSON.parse(postman), null, 2)],
  ruleRegExp: ['/^ab+c$/i', '^\\d+$', '^(\\d{1,3}\\.){3}\\d{1,3}$', '(GET|POST)+'],
  schemaPattern: ['^[a-z]+$', '^\\p{L}+$', '^(?=.*\\d).{8,}$'],
};
