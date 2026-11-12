---
description: Call REST and GraphQL APIs over HTTP/1.1 or HTTP/2.
icon: api
---

# REST and GraphQL

**HTTP** (REST and GraphQL) is the default request type, chosen by picking a method under HTTP in the select at the start of the URL bar. It covers REST, SOAP, and any other API reached by plain HTTP requests — see [Creating requests](requests.md) for every part of the editor.

## REST

Choose a method — GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, TRACE, or CONNECT — enter the URL, and add params, headers, and a body. HTTP/1.1 and HTTP/2 are both supported; choose automatic negotiation or HTTP/2 only in the request's **Settings**.

### TRACE and CONNECT

- **TRACE** asks the server to echo the request it received, to see what proxies and gateways changed on the way. It is sent without a body, as the standard requires; the echo is the response body.
- **CONNECT** asks a proxy to open a tunnel to the URL's host and port, such as `api.example.com:443` for `https://api.example.com`. When the request's **Proxy** setting applies, the CONNECT goes to that proxy, with its credentials; otherwise it goes to the URL's own server. The response shows the proxy's answer, such as `200 Connection established` or `407 Proxy Authentication Required` with its page. The tunnel is closed right away: nothing is sent through it. It is always sent over HTTP/1.1, without a body, and redirects are not followed.

Many servers refuse TRACE with `405`, and most refuse CONNECT unless they are a proxy. Use a [mock server](mock-servers.md) route with the method to try both locally.

## GraphQL

Send a GraphQL query as a **POST** with a JSON body holding `query` and, optionally, `variables`:

```json
{
  "query": "query User($id: ID!) { user(id: $id) { id name email } }",
  "variables": { "id": "1" }
}
```

Set the body to **Raw** with the **JSON** content type. To write the query with GraphQL highlighting instead, choose **GraphQL** as the language, or send `application/graphql` as the content type if your server accepts it.

> [!TIP]
> GraphQL requests imported from Postman, Bruno, Insomnia, Hoppscotch, and OpenCollection are converted to this JSON form automatically, with their variables.

## SOAP

Import a WSDL to generate SOAP 1.1 or 1.2 request templates — see [Import and export](import-export.md).

## Test and automate

Add [tests](tests.md) to check responses, [capture values](variables.md#capture-values-from-responses) to chain requests, and run whole collections in the [Runner](runner.md).
