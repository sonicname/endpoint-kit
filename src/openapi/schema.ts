/**
 * JSON Schema (OpenAPI 3.0 / 3.1 flavour) to zod source code.
 * Produces strings, not schemas, because the output is a generated file.
 */

/** The subset of JSON Schema this generator understands. Unknown keywords are ignored. */
export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  default?: unknown;
  description?: string;
  deprecated?: boolean;
  // string
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // number
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  // array
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  // object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  // composition
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
}

export interface SchemaContext {
  /** Resolve a `$ref` to the identifier of the generated constant. */
  refName: (ref: string) => string;
  /** Identifier of the zod import, usually `z`. */
  z: string;
}

/** `true` when `schema` references another component anywhere inside. */
export function containsRef(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  if (schema.$ref) return true;
  if (schema.items && containsRef(schema.items)) return true;
  if (typeof schema.additionalProperties === 'object' && containsRef(schema.additionalProperties)) {
    return true;
  }
  for (const list of [schema.oneOf, schema.anyOf, schema.allOf]) {
    if (list?.some(containsRef)) return true;
  }
  return Object.values(schema.properties ?? {}).some(containsRef);
}

/** Every `$ref` target reachable from `schema`. */
export function collectRefs(schema: JsonSchema | undefined, into = new Set<string>()): Set<string> {
  if (!schema) return into;
  if (schema.$ref) into.add(schema.$ref);
  collectRefs(schema.items, into);
  if (typeof schema.additionalProperties === 'object') {
    collectRefs(schema.additionalProperties, into);
  }
  for (const list of [schema.oneOf, schema.anyOf, schema.allOf]) {
    list?.forEach((item) => collectRefs(item, into));
  }
  Object.values(schema.properties ?? {}).forEach((item) => collectRefs(item, into));
  return into;
}

/** Convert a schema to zod source. */
export function schemaToZod(schema: JsonSchema | undefined, ctx: SchemaContext): string {
  const { z } = ctx;
  if (!schema) return `${z}.unknown()`;
  if (schema.$ref) return withNullable(ctx.refName(schema.$ref), schema, ctx);

  if (schema.const !== undefined)
    return withNullable(`${z}.literal(${literal(schema.const)})`, schema, ctx);

  if (schema.enum) {
    const values = schema.enum.filter((value) => value !== null);
    const hasNull = values.length !== schema.enum.length;
    let code: string;
    if (values.length === 0) code = `${z}.null()`;
    else if (values.every((value) => typeof value === 'string')) {
      code = `${z}.enum([${values.map(literal).join(', ')}])`;
    } else if (values.length === 1) {
      code = `${z}.literal(${literal(values[0])})`;
    } else {
      code = `${z}.union([${values.map((value) => `${z}.literal(${literal(value)})`).join(', ')}])`;
    }
    return withNullable(code, schema, ctx, hasNull);
  }

  if (schema.allOf?.length) {
    const parts = schema.allOf.map((part) => schemaToZod(part, ctx));
    const code = parts.reduce((acc, part) => `${z}.intersection(${acc}, ${part})`);
    return withNullable(code, schema, ctx);
  }

  const variants = schema.oneOf ?? schema.anyOf;
  if (variants?.length) {
    const code =
      variants.length === 1
        ? schemaToZod(variants[0], ctx)
        : `${z}.union([${variants.map((variant) => schemaToZod(variant, ctx)).join(', ')}])`;
    return withNullable(code, schema, ctx);
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nonNull = types.filter((type) => type !== 'null');
  const type = nonNull[0] ?? inferType(schema);

  let code: string;
  switch (type) {
    case 'string':
      code = stringSchema(schema, ctx);
      break;
    case 'integer':
    case 'number':
      code = numberSchema(schema, type === 'integer', ctx);
      break;
    case 'boolean':
      code = `${z}.boolean()`;
      break;
    case 'null':
      code = `${z}.null()`;
      break;
    case 'array': {
      code = `${z}.array(${schemaToZod(schema.items, ctx)})`;
      if (schema.minItems !== undefined) code += `.min(${String(schema.minItems)})`;
      if (schema.maxItems !== undefined) code += `.max(${String(schema.maxItems)})`;
      break;
    }
    case 'object':
      code = objectSchema(schema, ctx);
      break;
    default:
      code = `${z}.unknown()`;
  }

  if (nonNull.length > 1) {
    code = `${z}.union([${nonNull
      .map((single) => schemaToZod({ ...schema, type: single, nullable: false }, ctx))
      .join(', ')}])`;
  }

  return withNullable(code, schema, ctx, types.includes('null'));
}

function inferType(schema: JsonSchema): string | undefined {
  if (schema.properties || schema.additionalProperties !== undefined) return 'object';
  if (schema.items) return 'array';
  return undefined;
}

function stringSchema(schema: JsonSchema, ctx: SchemaContext): string {
  const { z } = ctx;
  if (schema.format === 'binary') return `${z}.instanceof(Blob)`;
  let code = `${z}.string()`;
  if (schema.minLength !== undefined) code += `.min(${String(schema.minLength)})`;
  if (schema.maxLength !== undefined) code += `.max(${String(schema.maxLength)})`;
  if (schema.pattern !== undefined) code += `.regex(new RegExp(${literal(schema.pattern)}))`;
  return code;
}

function numberSchema(schema: JsonSchema, integer: boolean, ctx: SchemaContext): string {
  let code = `${ctx.z}.number()`;
  if (integer) code += '.int()';
  if (typeof schema.exclusiveMinimum === 'number')
    code += `.gt(${String(schema.exclusiveMinimum)})`;
  else if (schema.minimum !== undefined) {
    code +=
      schema.exclusiveMinimum === true
        ? `.gt(${String(schema.minimum)})`
        : `.min(${String(schema.minimum)})`;
  }
  if (typeof schema.exclusiveMaximum === 'number')
    code += `.lt(${String(schema.exclusiveMaximum)})`;
  else if (schema.maximum !== undefined) {
    code +=
      schema.exclusiveMaximum === true
        ? `.lt(${String(schema.maximum)})`
        : `.max(${String(schema.maximum)})`;
  }
  if (schema.multipleOf !== undefined) code += `.multipleOf(${String(schema.multipleOf)})`;
  return code;
}

function objectSchema(schema: JsonSchema, ctx: SchemaContext): string {
  const { z } = ctx;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    if (schema.additionalProperties === undefined || schema.additionalProperties === true) {
      return `${z}.record(${z}.string(), ${z}.unknown())`;
    }
    if (schema.additionalProperties === false) return `${z}.object({})`;
    return `${z}.record(${z}.string(), ${schemaToZod(schema.additionalProperties, ctx)})`;
  }

  const lines = entries.map(([name, property]) => {
    let code = schemaToZod(property, ctx);
    if (property.default !== undefined && isPrimitive(property.default)) {
      code += `.default(${literal(property.default)})`;
    } else if (!required.has(name)) {
      code += '.optional()';
    }
    const key = propertyKey(name);
    // Properties referencing other components are getters so declaration order and
    // recursion never matter (zod v4 resolves getters lazily).
    return containsRef(property) ? `get ${key}() { return ${code}; }` : `${key}: ${code}`;
  });

  let code = `${z}.object({ ${lines.join(', ')} })`;
  if (typeof schema.additionalProperties === 'object') {
    code += `.catchall(${schemaToZod(schema.additionalProperties, ctx)})`;
  } else if (schema.additionalProperties === true) {
    code += `.catchall(${z}.unknown())`;
  }
  return code;
}

function withNullable(
  code: string,
  schema: JsonSchema,
  _ctx: SchemaContext,
  force = false,
): string {
  return schema.nullable === true || force ? `${code}.nullable()` : code;
}

function isPrimitive(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** JSON-encode a literal for source output. */
export function literal(value: unknown): string {
  const json = JSON.stringify(value) as string | undefined;
  return json ?? 'undefined';
}

/** Quote a property key unless it is a plain identifier. */
export function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : literal(name);
}
