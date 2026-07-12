import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const prepareAction = new URL('../prepare/action.yml', import.meta.url);
const setupCommand = new URL('commands/setup.ts', import.meta.url);

describe('prepare and setup Nix configuration', () => {
	it('keeps caller and builder settings separate from setup cache settings', async () => {
		const [prepare, setup] = await Promise.all([
			readFile(prepareAction, 'utf8'),
			readFile(setupCommand, 'utf8')
		]);

		expect({
			prepareConfigReferences: prepare.match(/cupboard-prepare-nix\.conf/gu)
				?.length,
			prepareReferencesSetupConfig: prepare.includes('cupboard-nix.conf'),
			setupReferencesPrepareConfig: setup.includes('cupboard-prepare-nix.conf'),
			setupWritesOwnConfig: setup.includes("'cupboard-nix.conf'")
		}).toStrictEqual({
			prepareConfigReferences: 4,
			prepareReferencesSetupConfig: false,
			setupReferencesPrepareConfig: false,
			setupWritesOwnConfig: true
		});
	});
});
