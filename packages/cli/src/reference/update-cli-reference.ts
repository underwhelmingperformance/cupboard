import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildProgram } from '../cli.ts';

import { renderCliReference } from './cli-reference.ts';
import { cliReferencePath } from './cli-reference-file.ts';

mkdirSync(path.dirname(cliReferencePath), { recursive: true });
writeFileSync(cliReferencePath, renderCliReference(buildProgram()));
