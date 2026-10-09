import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
	dependencyOutputs,
	Nix,
	tenantDependencyReferences
} from '@cupboard/nix';
import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	cacheNameSchema,
	cachePrioritySchema,
	type CacheScope,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { createReporter } from '@cupboard/reporter';
import { withCleanups } from '@cupboard/shared/cleanup';
import { describe, expect, it } from 'vitest';

import { audienceSchema } from '../../packages/cli/src/audience.ts';
import { pushAuthorizationDetails } from '../../packages/cli/src/auth/attenuate.ts';
import { referenceBuildPushClient } from '../../packages/cli/src/build-push/reference-client.ts';
import { targetDerivations } from '../../packages/cli/src/build-push/target-derivations.ts';
import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import { PublicationCollection } from '../../packages/cli/src/push/publication.ts';
import { runPush } from '../../packages/cli/src/push/push.ts';
import { parseReferenceManifest } from '../../packages/cli/src/push/reference-manifest.ts';
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

const sourceCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('pr-1')
};

describe('Nix substitution through a reuse view', () => {
	it.each(['public-view', 'private-view', 'private-cache'] as const)(
		'promotes cached profile build dependencies for a fresh destination-only consumer (%s)',
		(sourceMode) =>
			withTemporaryDirectory(
				'cupboard-e2e-tenant-dependencies-',
				async (directory) => {
					const server = await CupboardTestServer.start(directory);
					try {
						const token = await server.ownerAdminToken();
						const rpc = tenantRpc(server.tenantUrl, { credential: token });
						const source = await NixStore.host(
							path.join(directory, 'source-home')
						);
						const expression = String.raw`let
    mk = name: extra: derivation ({ inherit name; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "printf %s result > \"$out\"" ]; } // extra);
    client = mk "cupboard-patched-deployment-client" {};
    upstream = mk "cupboard-upstream-build-input" {};
    wrapper = mk "cupboard-activation-wrapper" { tool = client; inherit upstream; };
  in mk "cupboard-profile" { activation = wrapper; }`;
						const profile = storePathSchema.parse(
							await source.build(expression)
						);
						const profileInfo = await source.pathInfo(profile);
						const root = storePathSchema.parse(profileInfo.deriver);
						const nix = Nix.open();
						const rootTerm = await nix.readDerivation(root);
						const platform = rootTerm.buildRequirements.system;
						const flakeDirectory = path.join(directory, 'flake');
						await mkdir(flakeDirectory);
						await writeFile(
							path.join(flakeDirectory, 'flake.nix'),
							`{
  outputs = { self }: { packages.${platform}.profile = ${expression.replaceAll('builtins.currentSystem', () => JSON.stringify(platform))}; };
}`
						);
						const installable = `path:${flakeDirectory}#profile`;
						const outputLink = path.join(directory, 'result');
						await symlink(profile, outputLink);
						expect(
							await withCleanups(
								() =>
									targetDerivations(
										[installable, `${root}^out`, profile, outputLink],
										process.env
									),
								[() => unlink(outputLink)]
							)
						).toStrictEqual(
							new Map([
								[installable, [root]],
								[`${root}^out`, [root]],
								[profile, []],
								[outputLink, []]
							])
						);
						const required = await dependencyOutputs([root], {
							readDerivation: (path) => nix.readDerivation(path)
						});
						const client = required.find((output) =>
							output.storePath.endsWith('-cupboard-patched-deployment-client')
						)?.storePath;
						const wrapper = required.find((output) =>
							output.storePath.endsWith('-cupboard-activation-wrapper')
						)?.storePath;
						if (client === undefined || wrapper === undefined) {
							throw new Error(
								'The profile fixture did not declare its deployment dependencies'
							);
						}
						const unrelated = await source.build(reuseDerivation);
						await rpc.caches.put.inNamedCache({
							cacheName: sourceCache.name,
							access: sourceMode === 'public-view' ? 'public' : 'private',
							priority: 40
						});
						await pushStorePaths(
							{
								client: server.pushClient(token, { cache: sourceCache }),
								store: source
							},
							[profile, wrapper, client, unrelated]
						);
						await rpc.reuseViews.set({
							name: 'reuse',
							access: sourceMode === 'public-view' ? 'public' : 'private',
							selectors: [{ kind: 'prefix', prefix: 'pr-' }]
						});
						const requests: string[] = [];
						const fetchMetadata: typeof fetch = (input, init) => {
							requests.push(
								input instanceof Request ? input.url : String(input)
							);
							const headers = new Headers(init?.headers);
							headers.set('Authorization', `Bearer ${token}`);
							return fetch(input, { ...init, headers });
						};
						const sources = [
							{ url: server.tenantUrl, paths: [] },
							{
								url: server.tenantPath(
									sourceMode === 'private-cache'
										? '/cache/pr-1'
										: '/reuse/reuse'
								),
								paths: []
							}
						];
						const dependencies = await tenantDependencyReferences(
							required.map((output) => output.storePath),
							{ sources, fetch: fetchMetadata }
						);
						const target = await tenantDependencyReferences([profile], {
							sources,
							fetch: fetchMetadata
						});
						const references = parseReferenceManifest(
							JSON.stringify({
								version: 1,
								paths: [
									...target.map((entry) => ({ ...entry, kind: 'target' })),
									...dependencies
								]
							})
						);
						const runRoot = {
							name: 'github:acme/app/run/1',
							retention: { kind: 'inherit' as const }
						};
						const authority = pushAuthorizationDetails({
							cache: { kind: 'default' },
							attest: false,
							runRoot: rootNameSchema.parse(runRoot.name)
						});
						await rpc.oidcTrust.add({
							issuer: server.issuer.issuer,
							audience: audienceSchema.parse(server.tenantUrl),
							claims: { sub: 'dependency-promoter' },
							permittedGrants: [
								{
									type: 'cupboard_cache',
									actions: [
										'upload:negotiate',
										'upload:status',
										'upload:commit'
									],
									resources: { cache: { kind: 'default' } }
								},
								{
									type: 'cupboard_cache',
									actions: ['root:attach'],
									resources: {
										cache: { kind: 'default' },
										root: { exact: runRoot.name, validate: 'rootName' }
									}
								},
								{
									type: 'cupboard_cache',
									actions: ['cache:content-read'],
									resources: {
										cache: {
											kind: 'named',
											exact: sourceCache.name,
											validate: 'cacheName'
										}
									}
								},
								{
									type: 'cupboard_view',
									actions: ['view:content-read'],
									resources: {
										view: { exact: 'reuse', validate: 'reuseViewName' }
									}
								}
							]
						});
						const subject = server.issuer.sign({
							aud: server.tenantUrl.href,
							sub: 'dependency-promoter'
						});
						const initialToken = await server.exchangeIdToken(
							subject,
							authority
						);
						const initialClient = server.pushClient(initialToken);
						let selectedToken = initialToken;
						const destination = await referenceBuildPushClient(
							references.map((reference) => new URL(reference.source)),
							{
								tenantUrl: server.tenantUrl,
								cache: { kind: 'default' },
								client: initialClient,
								auth: {
									githubOidc: true,
									audience: audienceSchema.parse(server.tenantUrl),
									authorizationDetails: authority
								}
							},
							{
								authenticate: async (_client, auth) => {
									selectedToken = await server.exchangeIdToken(
										subject,
										auth.authorizationDetails
									);
									return {
										get: () => Promise.resolve(selectedToken),
										refresh: () => Promise.resolve(selectedToken)
									};
								},
								createClient: () => server.pushClient(selectedToken)
							}
						);
						const sink = new Writable({
							write(_chunk, _encoding, callback) {
								callback();
							}
						});
						const receipt = await runPush(
							PublicationCollection.of({ targets: [], references }),
							createReporter({ stream: sink, out: sink }),
							{
								command: 'cupboard push',
								credential: 'github-oidc',
								retain: false,
								referenceReceipt: true,
								runRoot,
								client: {
									...destination,
									uploadNar: () =>
										Promise.reject(
											new Error('Reference promotion must not upload a NAR')
										),
									uploadCompressedNar: () =>
										Promise.reject(
											new Error('Reference promotion must not upload a NAR')
										)
								}
							}
						);
						const consumer = await NixStore.chroot(
							path.join(directory, 'consumer'),
							path.join(directory, 'consumer-home')
						);
						const publicKey = await new CupboardClient(
							server.tenantUrl,
							fetch,
							{
								kind: 'default'
							}
						).publicKey();
						await consumer.realise(client, {
							substituter: server.tenantUrl.href,
							trustedPublicKeys: [publicKey],
							requireSigs: true
						});
						const unrelatedResponse = await fetch(
							server.tenantPath(`/${StorePath.hash(unrelated)}.narinfo`)
						);
						const retainedRoot = await rpc.roots.targets.inDefaultCache({
							name: 'github:acme/app/run/1'
						});
						expect({
							retained: retainedRoot.targets
								.map((target) => target.storePath)
								.toSorted((left, right) => left.localeCompare(right)),
							paths: receipt?.paths,
							origins: receipt?.subjects.map((subject) => subject.origin),
							content: await readFile(consumer.physicalPath(client), 'utf8'),
							narRequests: requests.filter((url) => url.includes('/nar/')),
							unrelatedStatus: unrelatedResponse.status
						}).toStrictEqual({
							retained: [profile, wrapper, client].toSorted((left, right) =>
								left.localeCompare(right)
							),
							paths: [profile, wrapper, client].toSorted((left, right) =>
								left.localeCompare(right)
							),
							origins: ['republished', 'republished', 'republished'],
							content: 'result',
							narRequests: [],
							unrelatedStatus: 404
						});
					} finally {
						await server.stop();
					}
				},
				{ makeWritableBeforeCleanup: true }
			)
	);

	it('substitutes a path pushed only to a selected cache through the view NAR route', () =>
		withTemporaryDirectory(
			'cupboard-e2e-reuse-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory);

				try {
					const client = new CupboardClient(server.tenantUrl, fetch, {
						kind: 'default'
					});
					const token = await server.ownerAdminToken();
					const rpc = tenantRpc(server.tenantUrl, { credential: token });
					const publicKey = await client.publicKey();
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(reuseDerivation);
					const storePathHash = StorePath.hash(storePath);
					const pushContext: PushContext = {
						client: server.pushClient(token, { cache: sourceCache }),
						store: source
					};

					// Only the selected source cache holds the path: substitution must
					// come from the reuse view, not a push to any other cache.
					await rpc.caches.put.inNamedCache({
						cacheName: sourceCache.name,
						access: 'public',
						priority: 40
					});
					await pushStorePaths(pushContext, [storePath]);

					await rpc.reuseViews.set({
						name: 'reuse',
						access: 'public',
						selectors: [{ kind: 'prefix', prefix: 'pr-' }]
					});

					const cacheInfoResponse = await fetch(
						server.tenantPath('/reuse/reuse/nix-cache-info')
					);
					const cacheInfoBody = await cacheInfoResponse.text();

					const narInfoResponse = await fetch(
						server.tenantPath(`/reuse/reuse/${storePathHash}.narinfo`)
					);
					const narInfo = NarInfo.parse(await narInfoResponse.text());
					const expectedNarUrl = `nar/${narInfo.narHash.toString()}.2.nar.zst`;

					// The view's NAR route checks that a selected cache references the
					// bytes before serving them.
					const reuseNarResponse = await fetch(
						server.tenantPath(`/reuse/reuse/${expectedNarUrl}`)
					);

					const target = await NixStore.chroot(
						path.join(directory, 'target'),
						path.join(directory, 'target-home')
					);

					// The load-bearing step: this only succeeds if Nix resolves the
					// narinfo's relative URL against the reuse-view base.
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
						reuseNarStatus: 200
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
					await rpc.caches.put.inNamedCache({
						cacheName: sourceCache.name,
						access: 'public',
						priority: 40
					});
					await pushStorePaths(
						{
							client: server.pushClient(token, { cache: sourceCache }),
							store: source
						},
						[storePath]
					);
					await rpc.reuseViews.set({
						name: 'reuse',
						access: 'public',
						selectors: [{ kind: 'prefix', prefix: 'pr-' }]
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
							command: 'cupboard push',
							credential: 'cupboard-login',
							client: {
								...destination,
								uploadNar: (r2Key, body) => {
									uploads.push(r2Key);

									return destination.uploadNar(r2Key, body);
								},
								uploadCompressedNar: (r2Key, source, narSize, observer) => {
									uploads.push(r2Key);

									return (
										destination.uploadCompressedNar?.(
											r2Key,
											source,
											narSize,
											observer
										) ?? Promise.reject(new Error('unexpected upload'))
									);
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
