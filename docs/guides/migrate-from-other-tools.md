---
description: Bring requests from Thunder Client, REST Client, JetBrains HTTP Client, OpenAPI, SoapUI, browsers, proxies, and cURL.
navTitle: More tools
icon: toolbox-outline
---

# Migrate from other tools

Most API tools can produce a format API Workbench imports, even when they have no export of their own. Find your tool below, then import as usual: click **Import** in the explorer, choose the files or paste the content, check the preview, and click **Import into workspace**.

## Editor and desktop clients

| Tool                                           | What to import                               | Notes                                                                                                                                                                                                                          |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **VS Code REST Client**                        | Your `.http` or `.rest` files                | Requests are split on `###`. File variables such as `@base_url = …` become an environment named **HTTP file variables**. Environments from VS Code settings are not read: recreate them in [Environments](../environments.md). |
| **JetBrains HTTP Client**                      | Your `.http` files                           | As above. Recreate `http-client.env.json` environments by hand, and the response handler scripts as [assertions](../tests.md) and [captures](../variables.md#capture-values-from-responses).                                   |
| **Thunder Client**                             | A Postman export, if your version offers one | Thunder Client's own JSON format is not supported. Without a Postman export, copy each request as cURL and paste it.                                                                                                           |
| **RapidAPI for Mac (Paw), HTTPie, and others** | A Postman, OpenAPI, HAR, or cURL export      | Use whichever of these the tool can write. Postman keeps the most: folders, auth, and environments. Then follow [Migrate from Postman](migrate-from-postman.md).                                                               |

## API descriptions

| Source                                     | What to import                           | Notes                                                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAPI 3.x or Swagger 2.0**             | The specification, JSON or YAML          | Requests are grouped by tag, with servers, parameters, and generated example bodies. Without a server, URLs use `{{base_url}}`. Local `$ref` files are bundled from a folder or ZIP; remote references are never fetched. |
| **SoapUI, ReadyAPI, and other SOAP tools** | The service's WSDL, not the project file | API Workbench generates SOAP 1.1 and 1.2 request templates for each operation.                                                                                                                                            |

## Recorded traffic

| Source                                        | What to import                                                                             | Notes                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser DevTools**                          | A HAR file: in the **Network** panel, right-click a request and choose **Save all as HAR** | HAR files can hold cookies and tokens, so review the requests before sharing them.                                                    |
| **Charles, Fiddler, Proxyman, and mitmproxy** | A HAR export of the session                                                                | Each recorded request becomes a request in API Workbench.                                                                             |
| **Any app, live**                             | Nothing to export                                                                          | Capture its traffic directly with the [Interceptor](../interceptor.md). See [Capture and replay app traffic](capture-app-traffic.md). |

## cURL

Paste one or more `curl` commands into the Import dialog and click **Preview pasted content**. Commands are parsed, never run. Most tools and browsers can copy a request as cURL — in browser DevTools, right-click a request and choose **Copy → Copy as cURL**.

## After importing

Whatever the source, finish the same way:

1. Read the preview notes for anything that wasn't converted.
2. Move tokens and passwords into the [credential vault](../credentials.md).
3. Group requests into collections and set collection auth, so each request can inherit it.
4. Add [tests](../tests.md) and run the collection in the [Runner](../runner.md).

> [!TIP]
> Not sure which format a file is? Import it anyway: API Workbench detects the format from the content, and the preview shows what it found before anything changes.
