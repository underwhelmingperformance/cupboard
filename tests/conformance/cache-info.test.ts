import { expect, it } from 'vitest';

import { openCache } from './cache-info.ts';
import { describeConformance } from './oracle.ts';

describeConformance('a cache directory opened as a substituter', (oracle) => {
	// Exact: Nix opens a cache with no `nix-cache-info` using the compiled-in
	// defaults, so both sides report the fixture path with the same fields.
	it('matches Nix for a cache with no cache info', async () => {
		const outcome = await openCache(oracle, { kind: 'directory' });

		expect({
			opened: outcome.oracle.opened,
			offer: outcome.client.offer,
			unreachable: outcome.client.unreachable
		}).toStrictEqual({
			opened: true,
			offer: outcome.oracle.offer,
			unreachable: []
		});
	});

	// Exact: Nix refuses to open a cache advertising another store's prefix, and
	// our client must also report that cache as unreachable.
	it('rejects a cache for another store as Nix does', async () => {
		const outcome = await openCache(oracle, {
			kind: 'directory',
			cacheInfo: 'StoreDir: /other/store\n'
		});

		expect({
			opened: outcome.oracle.opened,
			offer: outcome.client.offer,
			unreachable: outcome.client.unreachable
		}).toStrictEqual({
			opened: false,
			offer: undefined,
			unreachable: [
				{
					uri: outcome.client.uri,
					reason: 'store-directory-mismatch',
					servesStoreDirectory: '/other/store',
					queriedStoreDirectory: '/nix/store'
				}
			]
		});
	});

	// Exact: a store URI's parameters are settings, and Nix reads an integer
	// setting's entire value, so a suffix after the digits makes the URI invalid.
	it('rejects a store URI whose priority Nix cannot parse', async () => {
		const outcome = await openCache(oracle, {
			kind: 'directory',
			parameters: '?priority=5x'
		});

		expect({
			opened: outcome.oracle.opened,
			offer: outcome.client.offer,
			unreachable: outcome.client.unreachable
		}).toStrictEqual({
			opened: false,
			offer: undefined,
			unreachable: [{ uri: outcome.client.uri, reason: 'unreadable-uri' }]
		});
	});

	// Exact: a binary unit multiplies the preceding number. This client must
	// accept a priority that Nix accepts, and the parameter must not change the
	// cache contents.
	it('matches Nix when the priority uses a binary unit', async () => {
		const outcome = await openCache(oracle, {
			kind: 'directory',
			parameters: '?priority=5K'
		});

		expect({
			opened: outcome.oracle.opened,
			offer: outcome.client.offer,
			unreachable: outcome.client.unreachable
		}).toStrictEqual({
			opened: true,
			offer: outcome.oracle.offer,
			unreachable: []
		});
	});

	// Exact: only ENOENT represents an absent cache document. A store URI that
	// points to a regular file has no cache directory, so Nix refuses to open it.
	it('rejects a regular file as a cache, as Nix does', async () => {
		const outcome = await openCache(oracle, { kind: 'file' });

		expect({
			opened: outcome.oracle.opened,
			offer: outcome.client.offer,
			unreachable: outcome.client.unreachable
		}).toStrictEqual({
			opened: false,
			offer: undefined,
			unreachable: [{ uri: outcome.client.uri, reason: 'no-cache-info' }]
		});
	});
});
