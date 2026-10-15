/**
 * Generate endpoint-kit routes and zod schemas from an OpenAPI 3 document.
 *
 * ```ts
 * import { generateFromOpenApi } from 'endpoint-kit/openapi';
 * const { code, warnings } = generateFromOpenApi(JSON.parse(spec));
 * ```
 *
 * The CLI wraps this: `npx endpoint-kit openapi ./openapi.json -o src/api/routes.ts`.
 *
 * @packageDocumentation
 */
export { generateFromOpenApi } from './generate.js';
export type {
  GenerateOptions,
  GenerateResult,
  GeneratedRoute,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiRequestBody,
  OpenApiResponse,
} from './generate.js';
export { collectRefs, containsRef, schemaToZod } from './schema.js';
export type { JsonSchema, SchemaContext } from './schema.js';
