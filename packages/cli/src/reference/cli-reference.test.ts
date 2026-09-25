import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildProgram } from '../cli.ts';

import { renderCliReference } from './cli-reference.ts';
import { cliReferencePath } from './cli-reference-file.ts';

describe('CLI reference', () => {
	it('matches the command definitions; run `pnpm update:cli-reference` after changing them', () => {
		expect(readFileSync(cliReferencePath, 'utf8')).toBe(
			renderCliReference(buildProgram())
		);
	});
});
