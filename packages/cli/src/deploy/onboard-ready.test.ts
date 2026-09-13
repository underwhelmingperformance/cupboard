import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { tenantReadCredentialSchema } from '@cupboard/protocol/tenants';
import { describe, expect, it } from 'vitest';

import type { OnboardOutcome } from './onboard.ts';
import { showCacheCredential, showReadyCache } from './onboard-ready.ts';

const read = tenantReadCredentialSchema.parse({
	user: 'reader',
	password: 'p'.repeat(43)
});
const existing: Extract<OnboardOutcome, { kind: 'ready' }> = {
	kind: 'ready',
	url: 'https://cache.example',
	slug: 'builds',
	cacheUrl: new URL('https://cache.example/t/builds'),
	publicKey: 'cache.example:public-key'
};

describe('cache setup instructions', () => {
	it('delivers private credentials independently of readiness', () => {
		const { ui, captured } = fakeCliUi();
		showCacheCredential(
			ui,
			existing.cacheUrl,
			{ access: 'private', read },
			'confirmed'
		);
		expect(captured.notes).toStrictEqual([
			{
				title: 'Read credential for https://cache.example/t/builds',
				body: `Read user\treader\nRead password\t${read.password}`
			},
			{
				title: 'Add to /etc/nix/netrc',
				body: `\tmachine cache.example login reader password ${read.password}`
			}
		]);
	});
	it.each(['public', 'private'] as const)(
		'renders an existing %s cache without inventing a password',
		(access) => {
			const { ui, captured } = fakeCliUi();
			showReadyCache(ui, { ...existing, access });
			expect(captured.notes).toStrictEqual([
				{
					title: 'Add to your nix.conf (e.g. /etc/nix/nix.conf)',
					body: [
						'Cache URL\thttps://cache.example/t/builds',
						'\t',
						'\textra-substituters = https://cache.example/t/builds',
						'\textra-trusted-public-keys = cache.example:public-key',
						...(access === 'private' ? ['\tnetrc-file = /etc/nix/netrc'] : [])
					].join('\n')
				}
			]);
			expect(captured.infos).toStrictEqual(
				access === 'private'
					? [
							'Use the existing read credential in /etc/nix/netrc. If you no longer have it, run `cupboard tenant rotate-credential` to issue a replacement; existing clients will need the new password.'
						]
					: []
			);
		}
	);
	it('does not assume public access when the deployer cannot inspect the tenant', () => {
		const { ui, captured } = fakeCliUi();
		showReadyCache(ui, existing);
		expect({ notes: captured.notes, infos: captured.infos }).toStrictEqual({
			notes: [],
			infos: [
				'The deployment is ready, but this identity cannot inspect the cache. Sign in as its tenant administrator, run cupboard cache inspect https://cache.example/t/builds, and configure Nix for the reported access. If the cache is private and its read password is unavailable, ask the deployment administrator to rotate the credential.'
			]
		});
	});
});
