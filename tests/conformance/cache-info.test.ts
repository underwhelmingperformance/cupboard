import { expect, it } from 'vitest';

import { openCache } from './cache-info.ts';
import { describeConformance } from './oracle.ts';

describeConformance('a cache directory opened as a substituter', (oracle) => {
	// Exact: nix opens a cache serving no `nix-cache-info` with the compiled-in
	// defaults, so the path it holds is one both sides offer, field for field.
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
	// our client has to say the same rather than answer the query one cache
	// short without saying so.
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
	// setting's value whole, so a priority with anything after the digits names
	// none and the URI names no cache this run can open.
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
	// takes is one this client takes too, and the cache answers as it would
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

	// Exact: only the filesystem's answer for a file nobody wrote reads as a
	// cache holding nothing. A store URI naming a regular file has no cache
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
