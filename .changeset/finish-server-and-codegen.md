---
'endpoint-kit': minor
---

**Routes**

- `headers` on a route may now be a schema. The caller's `headers` are then typed and validated,
  and server handlers receive the validated object instead of raw `Headers`.
- `errors` maps accept `'4XX'`, `'5XX'` and `'default'` keys besides exact statuses; lookup is
  exact status, then class, then default. `findErrorFactory` is exported.

**Server**

- `endpoint-kit/server/node`: `createNodeHandler(routes, handlers)` for `http.createServer`,
  Express and Connect, with streamed bodies, `set-cookie` support, `trustProxy`, and fall-through
  to `next()` for unmatched paths.
- Thrown `TaggedError`s answer with their `status` (or `errorStatus`, else 500) and
  `{ error: _tag, message, data? }`, so client and server share one set of error classes.
- `coerce: false` disables the string-to-number/boolean retry when validating params, query,
  headers and form bodies.
- `registerHono` is tested against a real Hono app.

**OpenAPI generator**

- Header parameters become a `headers` schema on the route (previously a warning).
- `4XX`, `5XX` and `default` responses generate `ClientError`, `ServerError` and
  `UnexpectedError` classes and the matching `errors` entries.

**Housekeeping**

- Repository moved to `sonicname/endpoint-kit`; pnpm settings moved from `.npmrc` to
  `pnpm-workspace.yaml`.
