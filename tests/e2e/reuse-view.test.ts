import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { createReporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import { PublicationCollection } from '../../packages/cli/src/push/publication.ts';
import { runPush } from '../../packages/cli/src/push/push.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore } from '../support/nix.ts';
import { type PushContext, pushStorePaths } from '../support/push.ts';

const reuseDerivation = [
	'derivation {',
	'  name = "cupboard-reuse";',
	'  system = builtins.currentSystem;',
	'  builder = "/bin/sh";',
	String.raw`  args = [ "-c" "printf %s reuse > \"$out\"" ];`,
	'}'
].join('\n');

describe('Nix substitution through a reuse view', () => {
	it('substitutes a path pushed only to a selected cache, resolving the NAR through the tenant canonical route', () =>
		withTemporaryDirectory(
			'cupboard-e2e-reuse-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory);

				try {
					const client = new CupboardClient(server.tenantUrl);
					const token = await server.ownerAdminToken();
					const rpc = tenantRpc(server.tenantUrl, { credential: token });
					const publicKey = await client.publicKey();
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(reuseDerivation);
					const storePathHash = StorePath.hash(storePath);
					const pushContext: PushContext = {
						client: server.pushClient(token, { cache: 'pr-1' }),
						store: source
					};

					// Only the selected source cache holds the path: substitution must
					// come from the reuse view, not a push to any other cache.
					await pushStorePaths(pushContext, [storePath]);

					await rpc.reuseViews.set({
						name: 'reuse',
						selectors: [{ kind: 'prefix', pattern: 'pr-' }]
					});

					const cacheInfoResponse = await fetch(
						server.tenantPath('/reuse/reuse/nix-cache-info')
					);
					const cacheInfoBody = await cacheInfoResponse.text();

					const narInfoResponse = await fetch(
						server.tenantPath(`/reuse/reuse/${storePathHash}.narinfo`)
					);
					const narInfo = NarInfo.parse(await narInfoResponse.text());
					const expectedNarUrl = `../../nar/${narInfo.narHash.toString()}.2.nar.zst`;

					// A reuse view has no NAR route of its own: probing the relative
					// path the narinfo names must 404 beneath the view itself.
					const reuseNarResponse = await fetch(
						server.tenantPath(
							`/reuse/reuse/nar/${narInfo.narHash.toString()}.nar.zst`
						)
					);

					const target = await NixStore.chroot(
						path.join(directory, 'target'),
						path.join(directory, 'target-home')
					);

					// The load-bearing step: this only succeeds if Nix resolves the
					// narinfo's relative URL against the reuse base to the tenant's
					// canonical NAR route.
					await target.realise(storePath, {
						substituter: `${server.tenantUrl.href}/reuse/reuse`,
						trustedPublicKeys: [publicKey],
						requireSigs: true
					});

					const expectedCacheInfo = new CacheInfo(
						servedStoreDirectory,
						true,
						cachePrioritySchema.parse(50)
					);

					expect({
						substituted: await readFile(target.physicalPath(storePath), 'utf8'),
						cacheInfoBody,
						cacheInfoControl: cacheInfoResponse.headers.get('cache-control'),
						narInfoStorePath: narInfo.storePath.value,
						narInfoUrl: narInfo.url,
						narInfoControl: narInfoResponse.headers.get('cache-control'),
						reuseNarStatus: reuseNarResponse.status
					}).toStrictEqual({
						substituted: 'reuse',
						cacheInfoBody: expectedCacheInfo.render(),
						cacheInfoControl: 'no-store',
						narInfoStorePath: storePath,
						narInfoUrl: expectedNarUrl,
						narInfoControl: 'no-store',
						reuseNarStatus: 404
					});
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));

	it('publishes a view-held path to the destination by reference, with no NAR upload', () =>
		withTemporaryDirectory(
			'cupboard-e2e-reference-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory);

				try {
					const token = await server.ownerAdminToken();
					const rpc = tenantRpc(server.tenantUrl, { credential: token });
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(reuseDerivation);
					const storePathHash = StorePath.hash(storePath);

					// The path reaches only the selected source cache, so the
					// destination (the default cache) does not serve it yet; the
					// reuse view does.
					await pushStorePaths(
						{
							client: server.pushClient(token, { cache: 'pr-1' }),
							store: source
						},
						[storePath]
					);
					await rpc.reuseViews.set({
						name: 'reuse',
						selectors: [{ kind: 'prefix', pattern: 'pr-' }]
					});

					const before = await fetch(
						server.tenantPath(`/${storePathHash}.narinfo`)
					);

					const uploads: string[] = [];
					const destination = server.pushClient(token);
					const sink = new Writable({
						write(_chunk, _encoding, callback) {
							callback();
						}
					});

					await runPush(
						PublicationCollection.of({
							targets: [],
							referencePaths: [storePath]
						}),
						createReporter({ stream: sink, out: sink }),
						{
							client: {
								...destination,
								uploadNar: (r2Key, body) => {
									uploads.push(r2Key);

									return destination.uploadNar(r2Key, body);
								}
							},
							referenceSource: { url: server.tenantPath('/reuse/reuse') }
						}
					);

					const after = await fetch(
						server.tenantPath(`/${storePathHash}.narinfo`)
					);
					const served = NarInfo.parse(await after.text());

					expect({
						beforeStatus: before.status,
						uploads,
						afterStatus: after.status,
						servedStorePath: served.storePath.value
					}).toStrictEqual({
						beforeStatus: 404,
						uploads: [],
						afterStatus: 200,
						servedStorePath: storePath
					});
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));
});
