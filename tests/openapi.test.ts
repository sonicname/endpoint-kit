import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli.js';
import { createRepository } from '../src/index.js';
import type { Adapter, AdapterRequest } from '../src/index.js';
import { generateFromOpenApi, schemaToZod } from '../src/openapi/index.js';
import type { OpenApiDocument } from '../src/openapi/index.js';

const here = dirname(fileURLToPath(import.meta.url));

const petstore: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.example.com/v1' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
          { name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pets' } } },
          },
        },
      },
      post: {
        operationId: 'createPet',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } },
        },
        responses: {
          '201': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        operationId: 'showPetById',
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
      },
      delete: { responses: { '204': { description: 'deleted' } } },
    },
    '/pets/{petId}/photo': {
      post: {
        operationId: 'upload-photo',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string', format: 'binary' } },
                required: ['file'],
              },
            },
          },
        },
        responses: { '200': { content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
    '/events': {
      get: {
        responses: {
          '200': {
            content: { 'text/event-stream': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string', minLength: 1 },
          tag: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['available', 'sold'] },
          // recursive reference, must become a getter
          parent: { $ref: '#/components/schemas/Pet' },
          'odd-key': { type: 'boolean', default: false },
        },
      },
      NewPet: {
        allOf: [
          { $ref: '#/components/schemas/Pet' },
          { type: 'object', properties: { owner: { type: 'string' } } },
        ],
      },
      Pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' }, maxItems: 100 },
      Mixed: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'string or number' },
      Dict: { type: 'object', additionalProperties: { type: 'number' } },
    },
  },
};

describe('schemaToZod', () => {
  const ctx = { z: 'z', refName: (ref: string) => ref.split('/').pop() ?? '' };

  it('covers the common keywords', () => {
    expect(schemaToZod({ type: 'string', pattern: '^a' }, ctx)).toBe(
      'z.string().regex(new RegExp("^a"))',
    );
    expect(schemaToZod({ type: 'integer', minimum: 1, exclusiveMaximum: 10 }, ctx)).toBe(
      'z.number().int().min(1).lt(10)',
    );
    expect(schemaToZod({ type: ['string', 'null'] }, ctx)).toBe('z.string().nullable()');
    expect(schemaToZod({ type: ['string', 'number'] }, ctx)).toBe(
      'z.union([z.string(), z.number()])',
    );
    expect(schemaToZod({ enum: [1, 2] }, ctx)).toBe('z.union([z.literal(1), z.literal(2)])');
    expect(schemaToZod({ enum: ['a', null] }, ctx)).toBe('z.enum(["a"]).nullable()');
    expect(schemaToZod({ const: 'x' }, ctx)).toBe('z.literal("x")');
    expect(schemaToZod({ type: 'object' }, ctx)).toBe('z.record(z.string(), z.unknown())');
    expect(schemaToZod({ type: 'object', additionalProperties: false }, ctx)).toBe('z.object({})');
    expect(schemaToZod({ type: 'string', format: 'binary' }, ctx)).toBe('z.instanceof(Blob)');
    expect(schemaToZod({ $ref: '#/components/schemas/Pet', nullable: true }, ctx)).toBe(
      'Pet.nullable()',
    );
    expect(schemaToZod(undefined, ctx)).toBe('z.unknown()');
  });
});

describe('generateFromOpenApi', () => {
  const result = generateFromOpenApi(petstore, { importFrom: '../../src/index.js' });

  it('emits schemas in dependency order with getters for references', () => {
    expect(result.schemas).toEqual(['Pet', 'NewPet', 'Pets', 'Mixed', 'Dict']);
    expect(result.code).toContain('get parent() { return Pet.optional(); }');
    expect(result.code).toContain('"odd-key": z.boolean().default(false)');
    expect(result.code).toContain('export type Pet = z.infer<typeof Pet>;');
    expect(result.code).toContain(
      'export const servers = ["https://petstore.example.com/v1"] as const;',
    );
  });

  it('emits one route per operation with inferred names and warnings', () => {
    expect(result.routes.map((r) => `${r.name} ${r.method} ${r.path}`)).toEqual([
      'listPets get /pets',
      'createPet post /pets',
      'showPetById get /pets/:petId',
      'deletePetsByPetId delete /pets/:petId',
      'uploadPhoto post /pets/:petId/photo',
      'getEvents get /events',
    ]);
    expect(result.code).toContain(
      "createRoute.delete('/pets/:petId', { params: { petId: z.number().int() }, responseType: 'none' })",
    );
    expect(result.code).toContain("bodyType: 'multipart'");
    expect(result.code).toContain("responseType: 'sse', response: Pet");
    expect(result.warnings).toEqual([
      'GET /pets: header parameters (X-Trace) are not generated; pass them via `headers` at call time',
    ]);
  });

  it('produces code that imports, validates and calls', async () => {
    const dir = join(here, '.generated');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'petstore.ts');
    await writeFile(file, result.code, 'utf8');

    const generated = (await import(pathToFileURL(file).href)) as {
      routes: Record<string, never>;
      Pet: { parse: (v: unknown) => unknown };
    };

    expect(
      generated.Pet.parse({ id: 1, name: 'Rex', parent: { id: 0, name: 'Mom' } }),
    ).toMatchObject({
      id: 1,
      'odd-key': false,
    });
    expect(() => generated.Pet.parse({ id: 1, name: '' })).toThrow();

    const requests: AdapterRequest[] = [];
    const adapter: Adapter = {
      request: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: 200,
          statusText: '',
          headers: {},
          data: [{ id: 1, name: 'Rex' }],
        });
      },
    };
    const api = createRepository({ baseUrl: 'https://petstore.example.com/v1', adapter })
      .mergeAll(generated.routes)
      .build();

    const list = api['listPets'] as unknown as (
      input: unknown,
    ) => Promise<{ data: unknown; error: unknown }>;
    const { data, error } = await list({ query: { limit: 10, tags: ['a'] } });
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 1, name: 'Rex', 'odd-key': false }]);
    expect(requests[0]?.url).toBe('https://petstore.example.com/v1/pets?limit=10&tags=a');

    const tooMany = await list({ query: { limit: 1000 } });
    expect((tooMany.error as { _tag: string } | null)?._tag).toBe('ValidationError');
  });
});

describe('cli parseArgs', () => {
  it('parses command, spec and options', () => {
    expect(
      parseArgs(['openapi', 'spec.json', '-o', 'out.ts', '--name', 'api', '--no-types']),
    ).toMatchObject({
      command: 'openapi',
      spec: 'spec.json',
      out: 'out.ts',
      name: 'api',
      types: false,
    });
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['openapi', 'x', '-o'])).toThrow(/Missing value/);
  });
});
