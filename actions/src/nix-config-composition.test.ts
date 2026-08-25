import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const prepareAction = new URL('../prepare/action.yml', import.meta.url);
const prepareSshTransport = new URL(
	'../prepare/ssh-transport.sh',
	import.meta.url
);
const setupCommand = new URL('commands/setup.ts', import.meta.url);

describe('prepare and setup Nix configuration', () => {
	it('writes caller and builder settings separately from cache settings', async () => {
		const [prepareActionContents, prepareSshTransportContents, setup] =
			await Promise.all([
				readFile(prepareAction, 'utf8'),
				readFile(prepareSshTransport, 'utf8'),
				readFile(setupCommand, 'utf8')
			]);
		const prepare = `${prepareActionContents}\n${prepareSshTransportContents}`;

		expect({
			prepareConfigReferences: prepare.match(/cupboard-prepare-nix\.conf/gu)
				?.length,
			prepareReferencesSetupConfig: prepare.includes('cupboard-nix.conf'),
			setupReferencesPrepareConfig: setup.includes('cupboard-prepare-nix.conf'),
			setupWritesOwnConfig: setup.includes("'cupboard-nix.conf'")
		}).toStrictEqual({
			prepareConfigReferences: 6,
			prepareReferencesSetupConfig: false,
			setupReferencesPrepareConfig: false,
			setupWritesOwnConfig: true
		});
	});

	it('writes the substitution default before the caller settings', async () => {
		const contents = await readFile(prepareAction, 'utf8');
		const steps = contents
			.matchAll(/^ {4}- name: (?<step>.+)$/gmu)
			.map((match) => match.groups?.step)
			.toArray();

		expect({
			substitutionDefault: contents.includes('always-allow-substitutes = true'),
			// The last assignment in a nix.conf file wins, so the caller's
			// `nix-config` can only turn the default off by coming after it.
			configurationSteps: steps.filter((step) => step?.startsWith('Configure '))
		}).toStrictEqual({
			substitutionDefault: true,
			configurationSteps: [
				'Configure Nix substitution',
				'Configure extra Nix settings',
				'Configure Nix SSH transport'
			]
		});
	});
});
