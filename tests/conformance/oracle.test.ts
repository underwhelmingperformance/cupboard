import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { conformanceNixOutLink } from '../../scripts/conformance-oracle.ts';

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

	it('roots the Nix it resolved for as long as the suite runs', async () => {
		const linkDirectory = path.dirname(conformanceNixOutLink);
		const linkName = path.basename(conformanceNixOutLink);
		let storePath: string | undefined;
		// Nix records the link path as it was given. On macOS the temporary
		// directory has a second spelling under `/private`, so accept either.
		let canonicalDirectory = linkDirectory;

		try {
			storePath = await realpath(conformanceNixOutLink);
			canonicalDirectory = await realpath(linkDirectory);
		} catch {
			storePath = undefined;
		}

		const roots =
			storePath === undefined
				? undefined
				: await oracle.runTool('nix-store', ['--query', '--roots', storePath]);
		const links = (roots?.stdout ?? '')
			.split('\n')
			.filter(Boolean)
			.map((line) => line.split(' -> ', 1)[0] ?? '');
		const expected = new Set([
			conformanceNixOutLink,
			path.join(canonicalDirectory, linkName)
		]);

		expect({
			outLink: storePath !== undefined,
			rooted: links.some((link) => expected.has(link))
		}).toStrictEqual({ outLink: true, rooted: true });
	});
});
