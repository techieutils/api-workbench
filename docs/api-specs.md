---
description: Write OpenAPI and Swagger specifications with live validation, then turn them into collections and mock servers.
icon: api
---

# API specifications

**APIs** in the navigation rail keeps your API designs: OpenAPI 3.0, 3.1, and 3.2, and Swagger 2.0 documents, in YAML or JSON. Each specification is its own file in the workspace, so other tools can open it and git can track it.

## Create a specification

- **New specification** starts from a small, valid OpenAPI 3 template with two example operations.
- **Open file** reads a `.yaml`, `.yml`, or `.json` file. The text is kept exactly as written.
- **New from a collection** describes a collection's saved HTTP requests as OpenAPI 3.0.3, the same way [API documentation](api-documentation.md) does. You can also right-click a collection in the explorer and choose **Create API specification**.
- **From a mock server:** open a mock's **API docs** tab and choose **Create specification**, or choose **Create API specification** from the mock's menu. Its HTTP, SSE, and NDJSON routes are described as OpenAPI 3.0.3, with the mock's address as the server; routes that are turned off, and WebSocket, gRPC, Socket.IO, and MQTT routes, are left out. The specification is a copy: later changes to the mock's routes do not change it.

## Edit and validate

The **Editor** tab checks the document as you type. Badges show the version, the format, and how many errors and warnings there are. The problems are listed under the editor; choose one to jump to its line.

| Checked                                                   | Severity                                      |
| --------------------------------------------------------- | --------------------------------------------- |
| YAML or JSON syntax                                       | Error                                         |
| `openapi: 3.x` or `swagger: '2.0'`                        | Error                                         |
| `info.title`                                              | Error (a missing `info.version` is a warning) |
| A `paths` object, and each path starting with `/`         | Error                                         |
| Local `$ref`s that point to nothing                       | Error (external references are a warning)     |
| Operations without responses, and repeated `operationId`s | Warning                                       |

**Format** (beside the badges, and in the editor's right-click menu) tidies the document's indentation and spacing as YAML or JSON, whichever it is written in, and keeps its comments.

**Endpoints** lists every operation, grouped by its first tag, with deprecated ones struck through.

## Generate a collection

**Generate collection** makes a collection named after the specification, with a request for each operation: tagged operations go in a folder per tag. Requests use the first server's URL, the parameter and body examples, and the security scheme as authorization.

The collection stays linked to the specification. Generating again refreshes it: after you confirm, its requests are replaced by the ones the specification describes now, so edits made to those requests are lost.

## Start a mock server

**Start mock** creates a [mock server](mock-servers.md) with a route for every operation and starts it. Each route answers with the operation's first success response, using its example, or one built from its schema.

## Manage specifications

Right-click a specification in the list (or use **⋯**) to rename, duplicate, download, or delete it. Deleting a specification removes its file; collections and mocks made from it stay.

## Where they are saved

Specifications are saved in the workspace's `specs` folder, one file each, named after the specification. You can edit them in another editor while the app is open; changes reload into the window. See [Where your data is stored](installation.md#where-your-data-is-stored).

## From the command line

`api-workbench spec lint` checks a specification in CI and exits with `1` on an error; `spec generate` makes a collection from one, and `spec create` describes a collection. See [Specifications](cli.md#specifications).
