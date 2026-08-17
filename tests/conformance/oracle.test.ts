import { expect, it } from 'vitest';

import {
	generatedFromNix,
	nixIntegerWidths,
	nixSettingTypes
} from '../../packages/nix/src/setting-types.generated.ts';

import { describeConformance } from './oracle.ts';

describeConformance('the conformance oracle', (oracle) => {
	it('matches the generated Nix settings table', async () => {
		const table = await oracle.readSettingTable();

		expect({ version: oracle.version, ...table }).toStrictEqual({
			version: generatedFromNix,
			types: nixSettingTypes,
			integerWidths: nixIntegerWidths
		});
	});
});
