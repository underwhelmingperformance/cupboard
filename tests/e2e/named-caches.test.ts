import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client.ts';
import { CacheInfo } from '../../packages/shared/src/cache-info.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore } from '../support/nix.ts';
import { type PushContext, pushStorePaths } from '../support/push.ts';

const namedCacheDerivation = [
	'derivation {',
	'  name = "cupboard-named";',
	'  system = builtins.currentSystem;',
	'  builder = "/bin/sh";',
	String.raw`  args = [ "-c" "printf %s named > \"$out\"" ];`,
	'}'
].join('\n');

describe('Nix substitution from a named cache', () => {
	it('pushes to a named cache, substitutes through its prefix, and tears it down', () =>
		withTemporaryDirectory(
			'cupboard-e2e-named-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory);

				try {
					const client = new CupboardClient(server.url, server.uploadFetcher());
					const token = await server.ownerAdminToken();
					const publicKey = await client.publicKey();
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(namedCacheDerivation);
					const pushContext = (cache: string): PushContext => ({
						client: new CupboardClient(
							server.url,
							server.uploadFetcher(),
							cache === '' ? '' : `/cache/${cache}`
						),
						token: token,
						store: source,
						workDirectory: directory
					});

					await client.putCache(token, 'builds', 30);

					// Push the same path to the named and default caches: the NAR blob is
					// shared, so only one is stored.
					await pushStorePaths(pushContext('builds'), [storePath]);
					await pushStorePaths(pushContext(''), [storePath]);

					const target = await NixStore.chroot(
						path.join(directory, 'target'),
						path.join(directory, 'target-home')
					);
					await target.realise(storePath, {
						substituter: `${server.url.origin}/cache/builds`,
						trustedPublicKeys: [publicKey],
						requireSigs: true
					});

					const cacheInfo = await fetch(
						new URL('/cache/builds/nix-cache-info', server.url)
					);
					const cacheInfoBody = await cacheInfo.text();
					const stats = await client.stats(token);
					const listed = await client.listCaches(token);

					await client.removeCache(token, 'builds', true);
					const afterRemoval = await client.listCaches(token);

					expect({
						substituted: await readFile(target.physicalPath(storePath), 'utf8'),
						cacheInfo: cacheInfoBody,
						sharedNarBlobs: stats.narBlobs,
						caches: listed.caches.map((cache) => cache.name).toSorted(),
						afterRemoval: afterRemoval.caches.map((cache) => cache.name)
					}).toStrictEqual({
						substituted: 'named',
						cacheInfo: new CacheInfo('/nix/store', true, 30).render(),
						sharedNarBlobs: 1,
						caches: ['', 'builds'],
						afterRemoval: ['']
					});
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));
});
