import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import {
	cacheNameSchema,
	cachePrioritySchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
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

const defaultCache: CacheScope = { kind: 'default' };
const buildsCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('builds')
};

describe('Nix substitution from a named cache', () => {
	it('pushes to a named cache, substitutes through its prefix, and tears it down', () =>
		withTemporaryDirectory(
			'cupboard-e2e-named-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory);

				try {
					const client = new CupboardClient(server.tenantUrl, fetch, {
						kind: 'default'
					});
					const token = await server.ownerAdminToken();
					const rpc = tenantRpc(server.tenantUrl, {
						credential: token
					});
					const publicKey = await client.publicKey();
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(namedCacheDerivation);
					const pushContext = (cache: CacheScope): PushContext => ({
						client: server.pushClient(token, { cache }),
						store: source
					});

					await rpc.caches.put.inNamedCache({
						cacheName: buildsCache.name,
						access: 'public',
						priority: 30
					});

					// Push the same path to the named and default caches: the NAR blob is
					// shared, so only one is stored.
					await pushStorePaths(pushContext(buildsCache), [storePath]);
					await pushStorePaths(pushContext(defaultCache), [storePath]);

					const target = await NixStore.chroot(
						path.join(directory, 'target'),
						path.join(directory, 'target-home')
					);
					await target.realise(storePath, {
						substituter: `${server.tenantUrl.href}/cache/builds`,
						trustedPublicKeys: [publicKey],
						requireSigs: true
					});

					const cacheInfo = await fetch(
						server.tenantPath('/cache/builds/nix-cache-info')
					);
					const cacheInfoBody = await cacheInfo.text();
					const stats = await rpc.stats.cache.inDefaultCache({});
					const listed = await rpc.caches.list();

					await rpc.caches.remove({
						params: { cacheName: 'builds' },
						query: { force: true }
					});
					const afterRemoval = await rpc.caches.list();
					const expectedCacheInfo = new CacheInfo(
						servedStoreDirectory,
						true,
						cachePrioritySchema.parse(30)
					);

					expect({
						substituted: await readFile(target.physicalPath(storePath), 'utf8'),
						cacheInfo: cacheInfoBody,
						sharedNarBlobs: stats.narBlobs,
						caches: listed.caches.map((cache) => cache.scope),
						afterRemoval: afterRemoval.caches.map((cache) => cache.scope)
					}).toStrictEqual({
						substituted: 'named',
						cacheInfo: expectedCacheInfo.render(),
						sharedNarBlobs: 1,
						caches: [defaultCache, buildsCache],
						afterRemoval: [defaultCache]
					});
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));
});
