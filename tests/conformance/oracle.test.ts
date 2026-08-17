import { expect, it } from 'vitest';

import { describeConformance } from './oracle.ts';

import { nixSettingTables } from '#nix-setting-types';

describeConformance('the conformance oracle', (oracle) => {
	it('matches the generated Nix settings table', async () => {
		const table = await oracle.readSettingTable();
		const generated = nixSettingTables[oracle.system];

		expect({ version: oracle.version, ...table }).toStrictEqual({
			version: generated.generatedFromNix,
			types: generated.types,
			integerWidths: generated.integerWidths
		});
	});
});
