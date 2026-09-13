import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { canonicalHref } from '@cupboard/nix-store/url';

import type { OnboardOutcome } from './onboard.ts';
import type { DeployUi } from './ui.ts';

const netrcFile = '/etc/nix/netrc';

/**
Prints Nix configuration for the cache and guidance for existing credentials.
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
			`The deployment is ready, but this identity cannot inspect the cache. Sign in as its tenant administrator, run cupboard cache inspect ${cacheUrl}, and configure Nix for the reported access. If the cache is private and its read password is unavailable, ask the deployment administrator to rotate the credential.`
		);
		ui.outro(
			'Deployed and initialised. Inspect the cache before configuring Nix.'
		);
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
			.map((line) => ({ label: '', value: line }))
	]);

	if (access === 'private' && created === undefined) {
		ui.info(
			'Use the existing read credential in /etc/nix/netrc. If you no longer have it, run `cupboard tenant rotate-credential` to issue a replacement; existing clients will need the new password.'
		);
	}

	ui.outro(
		`Deployed and initialised. Next: cupboard push ${cacheUrl} ./result`
	);
}

/**
Delivers the credential supplied for creation, with its confirmation status.
*/
export function showCacheCredential(
	ui: Pick<DeployUi, 'note' | 'info'>,
	cacheUrl: URL,
	created: NonNullable<Extract<OnboardOutcome, { kind: 'ready' }>['created']>,
	creation: 'confirmed' | 'unconfirmed'
): void {
	const label =
		creation === 'confirmed'
			? 'Read credential'
			: 'Unconfirmed read credential';
	ui.note(`${label} for ${canonicalHref(cacheUrl)}`, [
		{ label: 'Read user', value: created.read.user },
		{ label: 'Read password', value: created.read.password }
	]);
	if (creation === 'unconfirmed') {
		ui.info(
			`Creation did not return a confirmed result. Save this credential and check cupboard tenant list ${cacheUrl.origin} before retrying. It is valid only if this creation succeeded. A rerun cannot recover the plaintext password.`
		);
		return;
	}
	ui.info(
		'Save this credential now, even if a later onboarding step fails. `cupboard tenant rotate-credential` replaces it.'
	);

	if (created.access !== 'private') {
		return;
	}

	ui.note(`Add to ${netrcFile}`, [
		{
			label: '',
			value: renderNetrc(
				cacheUrl,
				created.read.user,
				created.read.password
			).trimEnd()
		}
	]);
	ui.info(
		'Keep this file outside the Nix store and restrict access to the user running Nix or its daemon. If you use another location, set netrc-file to the same absolute path.'
	);
}
