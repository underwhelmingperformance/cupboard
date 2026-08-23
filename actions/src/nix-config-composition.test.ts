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
			prepareConfigReferences: 4,
			prepareReferencesSetupConfig: false,
			setupReferencesPrepareConfig: false,
			setupWritesOwnConfig: true
		});
	});
});
