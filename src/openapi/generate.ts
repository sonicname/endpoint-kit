import { ErrorClasses } from './errors.js';
import { collectRefs, literal, propertyKey, schemaToZod } from './schema.js';
import type { JsonSchema } from './schema.js';

// ---------------------------------------------------------------------------
// OpenAPI subset
// ---------------------------------------------------------------------------

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: JsonSchema;
  description?: string;
  deprecated?: boolean;
  $ref?: string;
}

export interface OpenApiMediaType {
  schema?: JsonSchema;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
  $ref?: string;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
  $ref?: string;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
}

export type OpenApiPathItem = Partial<Record<HttpVerb, OpenApiOperation>> & {
  parameters?: OpenApiParameter[];
};

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  servers?: { url: string; description?: string }[];
  paths?: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    parameters?: Record<string, OpenApiParameter>;
    requestBodies?: Record<string, OpenApiRequestBody>;
    responses?: Record<string, OpenApiResponse>;
  };
}

const VERBS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
type HttpVerb = (typeof VERBS)[number];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** Module the generated file imports `createRoute` from. Defaults to `endpoint-kit`. */
  importFrom?: string;
  /** Module the generated file imports `z` from. Defaults to `zod`. */
  zodFrom?: string;
  /** Name of the exported routes object. Defaults to `routes`. */
  routesName?: string;
  /** Emit `export type X = z.infer<typeof X>` next to every component schema. Defaults to `true`. */
  emitTypes?: boolean;
  /**
   * Emit one `TaggedError` class per 4xx/5xx status used by the spec and an `errors` map on
   * each route, so `error` unions are typed per status. Defaults to `true`.
   */
  emitErrors?: boolean;
}

export interface GeneratedRoute {
  name: string;
  method: HttpVerb;
  path: string;
  /** Headers declared as parameters, which the generator does not model. */
  headerParams: string[];
}

export interface GenerateResult {
  code: string;
  routes: GeneratedRoute[];
  schemas: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/** Generate endpoint-kit route declarations (and zod schemas) from an OpenAPI 3 document. */
export function generateFromOpenApi(
  doc: OpenApiDocument,
  options: GenerateOptions = {},
): GenerateResult {
  const importFrom = options.importFrom ?? 'endpoint-kit';
  const zodFrom = options.zodFrom ?? 'zod';
  const routesName = options.routesName ?? 'routes';
  const emitTypes = options.emitTypes ?? true;
  const emitErrors = options.emitErrors ?? true;
  const warnings: string[] = [];

  const names = new SchemaNames(doc.components?.schemas ?? {});
  const errorClasses = new ErrorClasses(names.identifiers());
  let needsErrorFromSchema = false;
  const ctx = { z: 'z', refName: (ref: string) => names.forRef(ref, warnings) };

  // --- components.schemas, in dependency order -----------------------------
  const schemaLines: string[] = [];
  for (const name of names.ordered(warnings)) {
    const schema = names.schema(name);
    const id = names.identifier(name);
    const comment = jsDoc(schema.description, schema.deprecated);
    schemaLines.push(`${comment}export const ${id} = ${schemaToZod(schema, ctx)};`);
    if (emitTypes) schemaLines.push(`export type ${id} = z.infer<typeof ${id}>;`);
  }

  // --- routes --------------------------------------------------------------
  const routeLines: string[] = [];
  const routes: GeneratedRoute[] = [];
  const usedNames = new Set<string>();

  for (const [rawPath, item] of Object.entries(doc.paths ?? {})) {
    for (const verb of VERBS) {
      const operation = item[verb];
      if (!operation) continue;

      const path = rawPath.replace(/\{([^}]+)\}/g, ':$1');
      const name = uniqueName(routeName(operation, verb, rawPath), usedNames);
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map((p) =>
        resolveParameter(p, doc),
      );

      const fields: string[] = [];
      const pathParams = parameters.filter((p) => p.in === 'path');
      const queryParams = parameters.filter((p) => p.in === 'query');
      const headerParams = parameters.filter((p) => p.in === 'header').map((p) => p.name);

      if (pathParams.length > 0) {
        const entries = pathParams.map(
          (p) => `${propertyKey(p.name)}: ${schemaToZod(p.schema ?? { type: 'string' }, ctx)}`,
        );
        fields.push(`params: { ${entries.join(', ')} }`);
      }

      if (queryParams.length > 0) {
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];
        for (const p of queryParams) {
          properties[p.name] = p.schema ?? { type: 'string' };
          if (p.required) required.push(p.name);
        }
        fields.push(`query: ${schemaToZod({ type: 'object', properties, required }, ctx)}`);
      }

      const body = resolveRequestBody(operation.requestBody, doc);
      if (body) {
        const [mediaType, media] = pickMedia(body.content ?? {});
        if (media) {
          let code = schemaToZod(media.schema, ctx);
          if (body.required !== true) code += '.optional()';
          fields.push(`body: ${code}`);
          if (mediaType.startsWith('multipart/')) fields.push(`bodyType: 'multipart'`);
          else if (mediaType === 'application/x-www-form-urlencoded')
            fields.push(`bodyType: 'form'`);
        }
      }

      const response = pickResponse(operation.responses ?? {}, doc);
      if (response.kind === 'json') fields.push(`response: ${schemaToZod(response.schema, ctx)}`);
      else if (response.kind === 'sse') {
        fields.push(`responseType: 'sse'`);
        if (response.schema) fields.push(`response: ${schemaToZod(response.schema, ctx)}`);
      } else if (response.kind !== 'unknown') fields.push(`responseType: '${response.kind}'`);

      if (emitErrors) {
        const entries: string[] = [];
        for (const [code, raw] of Object.entries(operation.responses ?? {})) {
          if (!/^[45]\d\d$/.test(code)) continue;
          const errorResponse = resolveResponse(raw, doc);
          const className = errorClasses.for(Number(code));
          const media = errorResponse.content ? pickMedia(errorResponse.content)[1] : undefined;
          if (media?.schema) {
            needsErrorFromSchema = true;
            entries.push(
              `${code}: errorFromSchema(${schemaToZod(media.schema, ctx)}, (data, ctx) => new ${className}(data, ctx))`,
            );
          } else {
            entries.push(`${code}: (ctx) => new ${className}(ctx.data, ctx)`);
          }
        }
        if (entries.length > 0) fields.push(`errors: { ${entries.join(', ')} }`);
      }

      if (headerParams.length > 0) {
        warnings.push(
          `${verb.toUpperCase()} ${rawPath}: header parameters (${headerParams.join(', ')}) are not generated; pass them via \`headers\` at call time`,
        );
      }

      const comment = jsDoc(
        [operation.summary, operation.description].filter(Boolean).join('\n\n'),
        operation.deprecated,
      );
      const args = fields.length > 0 ? `'${path}', { ${fields.join(', ')} }` : `'${path}'`;
      routeLines.push(`${comment}${propertyKey(name)}: createRoute.${verb}(${args}),`);
      routes.push({ name, method: verb, path, headerParams });
    }
  }

  // --- assemble ------------------------------------------------------------
  const imports = ['createRoute'];
  if (errorClasses.used.size > 0) imports.push('TaggedError');
  if (needsErrorFromSchema) imports.push('errorFromSchema');
  const header = [
    `// Generated by endpoint-kit from ${doc.info?.title ?? 'OpenAPI'}${doc.info?.version ? ` ${doc.info.version}` : ''}. Do not edit by hand.`,
    `import { ${imports.join(', ')} } from ${literal(importFrom)};`,
    `import { z } from ${literal(zodFrom)};`,
    '',
  ];
  if (errorClasses.used.size > 0) header.push(...errorClasses.declarations(), '');
  if (doc.servers?.length) {
    header.push(
      `export const servers = ${literal(doc.servers.map((server) => server.url))} as const;`,
      '',
    );
  }

  const code = [
    ...header,
    ...schemaLines,
    schemaLines.length > 0 ? '' : undefined,
    `export const ${routesName} = {`,
    ...routeLines.map((line) => indent(line)),
    '};',
    '',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');

  return {
    code,
    routes,
    schemas: names.ordered([]).map((name) => names.identifier(name)),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class SchemaNames {
  readonly #schemas: Record<string, JsonSchema>;
  readonly #identifiers = new Map<string, string>();

  constructor(schemas: Record<string, JsonSchema>) {
    this.#schemas = schemas;
    const used = new Set<string>();
    for (const name of Object.keys(schemas)) {
      this.#identifiers.set(name, uniqueName(toIdentifier(name), used));
    }
  }

  schema(name: string): JsonSchema {
    return this.#schemas[name] ?? {};
  }

  /** Every generated identifier, to keep error class names from colliding with them. */
  identifiers(): string[] {
    return [...this.#identifiers.values()];
  }

  identifier(name: string): string {
    return this.#identifiers.get(name) ?? toIdentifier(name);
  }

  forRef(ref: string, warnings: string[]): string {
    const name = ref.replace(/^#\/components\/schemas\//, '');
    if (!this.#identifiers.has(name)) {
      warnings.push(`unresolved $ref ${ref}, emitted as z.unknown()`);
      return 'z.unknown()';
    }
    return this.identifier(name);
  }

  /**
   * Component names in an order where every non-object schema comes after the schemas it
   * references. Object schemas reference others through getters, so they impose no order.
   */
  ordered(warnings: string[]): string[] {
    const names = Object.keys(this.#schemas);
    const deps = new Map<string, Set<string>>();
    for (const name of names) {
      const schema = this.schema(name);
      const lazy = isObjectSchema(schema);
      const refs = lazy
        ? new Set<string>()
        : new Set(
            [...collectRefs(schema)]
              .map((ref) => ref.replace(/^#\/components\/schemas\//, ''))
              .filter((dep) => dep !== name && this.#identifiers.has(dep)),
          );
      deps.set(name, refs);
    }

    const result: string[] = [];
    const done = new Set<string>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const name of names) {
        if (done.has(name)) continue;
        const pending = [...(deps.get(name) ?? [])].filter((dep) => !done.has(dep));
        if (pending.length === 0) {
          result.push(name);
          done.add(name);
          progress = true;
        }
      }
    }
    for (const name of names) {
      if (!done.has(name)) {
        warnings.push(`circular reference involving "${name}" cannot be ordered; declared last`);
        result.push(name);
      }
    }
    return result;
  }
}

function isObjectSchema(schema: JsonSchema): boolean {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  return (
    type === 'object' ||
    (!type && !!schema.properties && !schema.oneOf && !schema.anyOf && !schema.allOf)
  );
}

function resolveParameter(parameter: OpenApiParameter, doc: OpenApiDocument): OpenApiParameter {
  if (!parameter.$ref) return parameter;
  const name = parameter.$ref.replace(/^#\/components\/parameters\//, '');
  return doc.components?.parameters?.[name] ?? parameter;
}

function resolveRequestBody(
  body: OpenApiRequestBody | undefined,
  doc: OpenApiDocument,
): OpenApiRequestBody | undefined {
  if (!body?.$ref) return body;
  const name = body.$ref.replace(/^#\/components\/requestBodies\//, '');
  return doc.components?.requestBodies?.[name];
}

function resolveResponse(response: OpenApiResponse, doc: OpenApiDocument): OpenApiResponse {
  if (!response.$ref) return response;
  const name = response.$ref.replace(/^#\/components\/responses\//, '');
  return doc.components?.responses?.[name] ?? response;
}

function pickMedia(
  content: Record<string, OpenApiMediaType>,
): [string, OpenApiMediaType | undefined] {
  const preferred = [
    'application/json',
    'multipart/form-data',
    'application/x-www-form-urlencoded',
  ];
  for (const type of preferred) {
    const media = content[type];
    if (media) return [type, media];
  }
  const [first] = Object.entries(content);
  return first ?? ['', undefined];
}

type ResponsePick =
  | { kind: 'json'; schema: JsonSchema | undefined }
  | { kind: 'sse'; schema: JsonSchema | undefined }
  | { kind: 'text' | 'blob' | 'none' | 'unknown' };

function pickResponse(
  responses: Record<string, OpenApiResponse>,
  doc: OpenApiDocument,
): ResponsePick {
  const codes = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code) || code === '2XX')
    .sort();
  const code = codes[0] ?? (responses['default'] ? 'default' : undefined);
  if (code === undefined) return { kind: 'unknown' };
  if (code === '204') return { kind: 'none' };

  const response = resolveResponse(responses[code] ?? {}, doc);
  const content = response.content ?? {};
  const types = Object.keys(content);
  if (types.length === 0) return { kind: 'none' };

  const json = types.find((type) => type.includes('json'));
  if (json) return { kind: 'json', schema: content[json]?.schema };
  if (types.includes('text/event-stream')) {
    return { kind: 'sse', schema: content['text/event-stream']?.schema };
  }
  if (types.some((type) => type.startsWith('text/'))) return { kind: 'text' };
  return { kind: 'blob' };
}

function routeName(operation: OpenApiOperation, verb: HttpVerb, path: string): string {
  if (operation.operationId) return toCamel(operation.operationId);
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith('{') ? `By${toPascal(segment.slice(1, -1))}` : toPascal(segment),
    );
  return toCamel(`${verb}${segments.join('')}`);
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let counter = 2;
  while (used.has(name)) name = `${base}${String(counter++)}`;
  used.add(name);
  return name;
}

function toIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^_+|_+$/g, '');
  const id = cleaned.length > 0 ? cleaned : 'Schema';
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

function toPascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toCamel(value: string): string {
  const pascal = toPascal(value);
  const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  return /^[0-9]/.test(camel) ? `_${camel}` : camel || 'route';
}

function jsDoc(text: string | undefined, deprecated: boolean | undefined): string {
  const lines: string[] = [];
  if (text) lines.push(...text.trim().split('\n'));
  if (deprecated) lines.push('@deprecated');
  if (lines.length === 0) return '';
  return `/**\n${lines.map((line) => ` * ${line.replace(/\*\//g, '* /')}`).join('\n')}\n */\n`;
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}
