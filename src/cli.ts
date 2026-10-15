import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { generateFromOpenApi } from './openapi/generate.js';
import type { OpenApiDocument } from './openapi/generate.js';

const USAGE = `endpoint-kit: typed API clients from route declarations

Usage:
  endpoint-kit openapi <spec.json|spec.yaml> [options]

Options:
  -o, --out <file>        Write the generated TypeScript here (default: stdout)
  --name <identifier>     Name of the exported routes object (default: routes)
  --import-from <module>  Module to import createRoute from (default: endpoint-kit)
  --zod-from <module>     Module to import z from (default: zod)
  --no-types              Do not emit "export type X = z.infer<typeof X>"
  -h, --help              Show this help

YAML specs need the "yaml" package installed (npm i -D yaml).
`;

interface CliArgs {
  command: string | undefined;
  spec: string | undefined;
  out: string | undefined;
  name: string | undefined;
  importFrom: string | undefined;
  zodFrom: string | undefined;
  types: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: undefined,
    spec: undefined,
    out: undefined,
    name: undefined,
    importFrom: undefined,
    zodFrom: undefined,
    types: true,
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-o':
      case '--out':
        args.out = next();
        break;
      case '--name':
        args.name = next();
        break;
      case '--import-from':
        args.importFrom = next();
        break;
      case '--zod-from':
        args.zodFrom = next();
        break;
      case '--no-types':
        args.types = false;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
        positional.push(arg);
    }
  }
  args.command = positional[0];
  args.spec = positional[1];
  return args;
}

async function loadSpec(file: string): Promise<OpenApiDocument> {
  const text = await readFile(resolve(file), 'utf8');
  const ext = extname(file).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    const moduleName = 'yaml';
    let yaml: { parse: (source: string) => unknown };
    try {
      yaml = (await import(moduleName)) as { parse: (source: string) => unknown };
    } catch {
      throw new Error('Parsing YAML needs the "yaml" package: npm i -D yaml');
    }
    return yaml.parse(text) as OpenApiDocument;
  }
  return JSON.parse(text) as OpenApiDocument;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help || args.command === undefined) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }
  if (args.command !== 'openapi') {
    process.stderr.write(`Unknown command "${args.command}"\n\n${USAGE}`);
    return 2;
  }
  if (!args.spec) {
    process.stderr.write(`Missing <spec> argument\n\n${USAGE}`);
    return 2;
  }

  const doc = await loadSpec(args.spec);
  const result = generateFromOpenApi(doc, {
    routesName: args.name ?? 'routes',
    importFrom: args.importFrom ?? 'endpoint-kit',
    zodFrom: args.zodFrom ?? 'zod',
    emitTypes: args.types,
  });

  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

  if (args.out) {
    await writeFile(resolve(args.out), result.code, 'utf8');
    process.stderr.write(
      `Wrote ${String(result.routes.length)} routes and ${String(result.schemas.length)} schemas to ${args.out}\n`,
    );
  } else {
    process.stdout.write(result.code);
  }
  return 0;
}

// Only run when executed directly (the bin), not when imported by tests.
if (process.argv[1] && /[\\/]cli\.(js|cjs|mjs|ts)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
