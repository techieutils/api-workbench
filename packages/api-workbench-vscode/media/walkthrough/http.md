# .http files

```http
@baseUrl = http://localhost:4010

### List orders
GET {{baseUrl}}/orders?limit=10
Accept: application/json
```

Above each request are **Send request**, **Generate code**, **Open in Workbench**, and **Save to collection**. Values a request captures are given to the requests after it in the same file.
