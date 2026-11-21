import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const prepareAction = new URL('../prepare/action.yml', import.meta.url);
const prepareSshTransport = new URL(
	'../prepare/ssh-transport.sh',
	import.meta.url
);
const prepareFlakeInputCache = new URL(
	'../prepare/flake-input-cache.sh',
	import.meta.url
);
const setupCommand = new URL('commands/setup.ts', import.meta.url);

describe('prepare and setup Nix configuration', () => {
	it('writes caller and builder settings separately from cache settings', async () => {
		const [
			prepareActionContents,
			prepareSshTransportContents,
			prepareFlakeInputCacheContents,
			setup
		] = await Promise.all([
			readFile(prepareAction, 'utf8'),
			readFile(prepareSshTransport, 'utf8'),
			readFile(prepareFlakeInputCache, 'utf8'),
			readFile(setupCommand, 'utf8')
		]);
		const prepare = [
			prepareActionContents,
			prepareSshTransportContents,
			prepareFlakeInputCacheContents
		].join('\n');

		expect({
			prepareConfigReferences: prepare.match(/cupboard-prepare-nix\.conf/gu)
				?.length,
			prepareReferencesSetupConfig: prepare.includes('cupboard-nix.conf'),
			setupReferencesPrepareConfig: setup.includes('cupboard-prepare-nix.conf'),
			setupWritesOwnConfig: setup.includes(
				'`cupboard-nix-${randomUUID()}.conf`'
			)
		}).toStrictEqual({
			prepareConfigReferences: 7,
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
				'Configure Nix SSH transport',
				'Configure the remote build hook'
			]
		});
	});

	// The evaluation of the caller's `nix-config` is the first Nix evaluation of
	// the job, so the cache is restored before it. The job's substituters gain
	// the cache only after every step that can configure builders.
	it('restores the flake input cache first and uses it last', async () => {
		const contents = await readFile(prepareAction, 'utf8');
		const steps = contents
			.matchAll(/^ {4}- name: (?<step>.+)$/gmu)
			.map((match) => match.groups?.step)
			.toArray();

		expect(
			steps.filter(
				(step) =>
					step?.endsWith('flake input cache') === true ||
					step?.startsWith('Configure ') === true
			)
		).toStrictEqual([
			'Configure Nix substitution',
			'Locate the flake input cache',
			'Restore the flake input cache',
			'Record the restored flake input cache',
			'Configure extra Nix settings',
			'Configure Nix SSH transport',
			'Configure the remote build hook',
			'Use the flake input cache'
		]);
	});
});
