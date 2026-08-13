import { expect, it } from 'vitest';

import { openCache } from './cache-info.ts';
import { describeConformance } from './oracle.ts';

describeConformance('a cache directory opened as a substituter', (oracle) => {
	// Exact: nix opens a cache serving no `nix-cache-info` with the compiled-in
	// defaults, so both sides report the fixture path with the same fields.
	it('offers what nix offers from a cache serving no cache info', async () => {
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

	// Exact: nix refuses to open a cache advertising another store's prefix, and
	// our client must also report that cache as unreachable.
	it('names a cache serving another store, as nix refuses to open one', async () => {
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

	// Exact: a store URI's parameters are settings, and nix reads an integer
	// setting's entire value, so a suffix after the digits makes the URI invalid.
	it('names a store URI stating a priority nix cannot read', async () => {
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

	// Exact: a binary unit multiplies the number before it, so a priority nix
	// accepts must also be accepted by this client, and the cache behaves as it would
	// have without the parameter.
	it('offers what nix offers under a priority stated in binary units', async () => {
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
	// points to a regular file has no cache directory
	// under it, and nix refuses to open one.
	it('names a store URI holding a regular file, as nix refuses to open one', async () => {
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
