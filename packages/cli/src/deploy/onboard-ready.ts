import { NixConfig } from '@cupboard/nix-store/nix-config';
import { canonicalHref } from '@cupboard/nix-store/url';

import type { OnboardOutcome } from './onboard.ts';
import type { DeployUi } from './ui.ts';

const netrcFile = '/etc/nix/netrc';

/**
Prints Nix configuration for the cache, and for a private cache, where its
access key goes.
*/
export function showReadyCache(
	ui: Pick<DeployUi, 'note' | 'info' | 'outro'>,
	outcome: Extract<OnboardOutcome, { kind: 'ready' }>
): void {
	const cacheUrl = canonicalHref(outcome.cacheUrl);
	const created = outcome.created;
	const access = outcome.access ?? created?.access;

	if (access === undefined) {
		ui.info(
			`The deployment is ready, but this identity cannot inspect the cache. Sign in as its tenant administrator, run cupboard cache inspect ${cacheUrl}, and configure Nix for the reported access. A private cache needs an access key in each reader's netrc.`
		);
		ui.outro('Deployment verified. Inspect the cache before configuring Nix.');
		return;
	}

	const nixConfig = new NixConfig(
		outcome.cacheUrl,
		outcome.publicKey,
		access === 'private' ? { netrcFile } : {}
	);

	ui.note('Add to your nix.conf (e.g. /etc/nix/nix.conf)', [
		{ label: 'Cache URL', value: cacheUrl },
		{ label: '', value: '' },
		...nixConfig
			.render()
			.trimEnd()
			.split('\n')
			.map((line) => ({ label: '', value: line, raw: true }))
	]);

	if (access === 'private') {
		ui.info(
			`The cache is private. Put an access key that can read it in ${netrcFile} as the password for ${outcome.cacheUrl.hostname}. A tenant administrator creates access keys.`
		);
	}

	ui.outro(`Deployment verified. Next: cupboard push ${cacheUrl} ./result`);
}
