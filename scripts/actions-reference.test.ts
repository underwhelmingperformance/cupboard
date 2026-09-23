import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
	actionsReferencePath,
	readReferenceSources,
	renderActionsReference
} from './actions-reference.ts';

describe('actions reference', () => {
	it('matches the action and workflow definitions; run `pnpm update:actions-reference` after changing them', () => {
		expect(readFileSync(actionsReferencePath, 'utf8')).toBe(
			renderActionsReference(readReferenceSources())
		);
	});
});
