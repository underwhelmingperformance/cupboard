import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { describe, expect, it } from 'vitest';

import type { OnboardOutcome } from './onboard.ts';
import { showReadyCache } from './onboard-ready.ts';

const existing: Extract<OnboardOutcome, { kind: 'ready' }> = {
	kind: 'ready',
	url: 'https://cache.example',
	slug: 'builds',
	cacheUrl: new URL('https://cache.example/t/builds'),
	publicKey: 'cache.example:public-key'
};

describe('cache setup instructions', () => {
	it.each(['public', 'private'] as const)(
		'renders Nix configuration for an existing %s cache',
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
							'The cache is private. Put an access key that can read it in /etc/nix/netrc as the password for cache.example. A tenant administrator creates access keys.'
						]
					: []
			);
		}
	);
	it('names the netrc machine without the port of a private cache', () => {
		const { ui, captured } = fakeCliUi();
		showReadyCache(ui, {
			...existing,
			url: 'http://localhost:8787',
			cacheUrl: new URL('http://localhost:8787/t/builds'),
			access: 'private'
		});
		expect(captured.infos).toStrictEqual([
			'The cache is private. Put an access key that can read it in /etc/nix/netrc as the password for localhost. A tenant administrator creates access keys.'
		]);
	});
	it('does not assume public access when the deployer cannot inspect the tenant', () => {
		const { ui, captured } = fakeCliUi();
		showReadyCache(ui, existing);
		expect({ notes: captured.notes, infos: captured.infos }).toStrictEqual({
			notes: [],
			infos: [
				"The deployment is ready, but this identity cannot inspect the cache. Sign in as its tenant administrator, run cupboard cache inspect https://cache.example/t/builds, and configure Nix for the reported access. A private cache needs an access key in each reader's netrc."
			]
		});
	});
});
