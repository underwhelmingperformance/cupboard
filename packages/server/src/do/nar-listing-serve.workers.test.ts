import {
	type CacheAccessMode,
	cacheGenerationSchema,
	cacheReadRevisionSchema,
	type CacheScope,
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	artifactGenerationSchema,
	currentListingGeneratorRevision,
	listingGeneratorRevisionSchema
} from '@cupboard/protocol/artifacts';
import { reuseViewRevisionSchema } from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { ArtifactReadChangedError } from '../errors.ts';
import { casObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	cacheScopedPath,
	commitUpload,
	currentServer,
	defaultCache,
	expectSingleUploadDecision,
	fixtureWorkerServer,
	initialise,
	initialiseViaWorker,
	namedCache,
	negotiateUploads,
	provisionFixtureTenant,
	pushPathToTenant,
	putNarBytes,
	putTestCache,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import {
	artifactFixtureGeneration as generation,
	artifactFixtureId as id,
	createArtifact
} from './artifact.test-support.ts';
import { ArtifactCasService } from './artifact-cas-service.ts';
import { ArtifactRetentionService } from './artifact-retention-service.ts';
import { type ServerContext } from './context.ts';
import { NarListingReadService } from './nar-listing-read-service.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import { setView } from './reuse-view-read.test-support.ts';

const hash = storePathHashSchema.parse('a'.repeat(32));
const listing = JSON.stringify({
	version: 1,
	root: { type: 'directory', entries: {} }
});

async function seedListing(
	scope: CacheScope = defaultCache(),
	isWorker = false,
	access: CacheAccessMode = 'public'
) {
	const token = await (isWorker ? initialiseViaWorker() : initialise());
	if (isWorker) {
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
	}
	if (scope.kind === 'named') {
		await (isWorker
			? putWorkerTestCache(token, scope, access)
			: putTestCache(token, scope));
	}
	await recordTransition('native-artifact-storage', 'expanded');
	await recordTransition('native-artifact-publication', 'complete');
	const nar = await verifiableNar('listing-read');
	const metadata = uploadMetadata({
		storePathHash: hash,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	if (isWorker) {
		await pushPathToTenant(fixtureTenant, token, metadata, nar, scope);
	} else {
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata], scope),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);
		await commitUpload(token, upload.uploadId, scope);
	}
	const { artifact, parentGeneration } = await runInDurableObject(
		isWorker ? fixtureWorkerServer() : currentServer(),
		async (instance) => {
			const context = instance.context;
			return context.criticalSection(async () => {
				const artifact = await createArtifact(
					context,
					'listing',
					new TextEncoder().encode(listing),
					scope
				);
				const parent = context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, artifact.cache.id),
							eq(schema.narInfos.storePathHash, hash)
						)
					)
					.get();
				if (parent === undefined) {
					throw new Error('The listing fixture NAR was not published');
				}
				const parentGeneration = parent.generation;
				context.db
					.insert(schema.narListings)
					.values({
						artifactId: id,
						cacheId: artifact.cache.id,
						narHash: nar.narHash,
						generatorRevision: currentListingGeneratorRevision,
						format: 1
					})
					.run();
				await new ArtifactCasService(context).reserveInSection(id, generation);
				await new ArtifactRetentionService(context).attachParentInSection(
					{ id, generation },
					{
						cache: artifact.cache,
						storePathHash: hash,
						generation: parentGeneration
					}
				);
				context.db
					.update(schema.artifacts)
					.set({ state: 'live', completedAt: artifact.createdAt })
					.where(eq(schema.artifacts.id, id))
					.run();
				return { artifact, parentGeneration };
			});
		}
	);
	return { token, nar, metadata, parentGeneration, artifact, scope };
}
type Fixture = Awaited<ReturnType<typeof seedListing>>;
const unavailable = [
	'pending',
	'retired',
	'expired',
	'old-revision',
	'missing-parent',
	'missing-reference',
	'artifact-generation',
	'cache-generation',
	'cas-incarnation',
	'revoked-nar',
	'missing-object',
	'fact-only'
] as const;
type Change = (typeof unavailable)[number];
async function invalidate(
	context: ServerContext,
	fixture: Fixture,
	change: Change
): Promise<void> {
	switch (change) {
		case 'pending':
		case 'retired': {
			context.db
				.update(schema.artifacts)
				.set({ state: change })
				.where(eq(schema.artifacts.id, id))
				.run();
			return;
		}
		case 'expired': {
			const expiresAt = isoTimestamp(new Date(Date.now() - 1));
			context.db
				.update(schema.artifacts)
				.set({ expiresAt })
				.where(eq(schema.artifacts.id, id))
				.run();
			return;
		}
		case 'old-revision': {
			context.db
				.update(schema.narListings)
				.set({
					generatorRevision: listingGeneratorRevisionSchema.parse('nix-v1-r0')
				})
				.where(eq(schema.narListings.artifactId, id))
				.run();
			return;
		}
		case 'missing-parent': {
			context.db
				.delete(schema.artifactParents)
				.where(eq(schema.artifactParents.artifactId, id))
				.run();
			return;
		}
		case 'missing-reference': {
			await context.d1
				.delete(d1Schema.artifactReference)
				.where(eq(d1Schema.artifactReference.artifactId, id));
			return;
		}
		case 'artifact-generation': {
			await context.d1
				.update(d1Schema.artifactReference)
				.set({
					artifactGeneration: artifactGenerationSchema.parse(generation + 1)
				})
				.where(eq(d1Schema.artifactReference.artifactId, id));
			return;
		}
		case 'cache-generation': {
			await context.d1
				.update(d1Schema.cacheLifecycle)
				.set({
					generation: cacheGenerationSchema.parse(
						fixture.artifact.cache.generation + 1
					)
				})
				.where(eq(d1Schema.cacheLifecycle.tenant, context.requireTenant()));
			return;
		}
		case 'cas-incarnation': {
			await context.d1
				.update(d1Schema.casObject)
				.set({ incarnation: fixture.artifact.incarnation + 1 })
				.where(eq(d1Schema.casObject.digest, fixture.artifact.digest));
			return;
		}
		case 'revoked-nar': {
			await new PathReadAuthorityService(context).revoke(
				fixture.artifact.cache,
				[{ storePathHash: hash, generation: fixture.parentGeneration }]
			);
			return;
		}
		case 'missing-object': {
			await context.env.BLOBS.delete(
				casObjectKey(fixture.artifact.digest, fixture.artifact.incarnation)
			);
			return;
		}
		case 'fact-only': {
			context.db
				.delete(schema.narListings)
				.where(eq(schema.narListings.artifactId, id))
				.run();
			await context.d1.insert(d1Schema.listingFact).values({
				narHash: fixture.nar.narHash,
				generatorRevision: currentListingGeneratorRevision,
				format: 1,
				digest: fixture.artifact.digest,
				size: fixture.artifact.size,
				createdAt: fixture.artifact.createdAt
			});
		}
	}
}
function listingRequest(
	scope: CacheScope = defaultCache(),
	init?: RequestInit
): Request {
	return new Request(
		`https://cupboard.invalid${cacheScopedPath(scope, `/${hash}.ls`)}`,
		init
	);
}

describe('native listing reads', () => {
	beforeEach(async () => {
		await resetTestServer();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const database = instance.context.db;
			database
				.delete(schema.artifactParents)
				.where(eq(schema.artifactParents.artifactId, id))
				.run();
			database
				.delete(schema.narListings)
				.where(eq(schema.narListings.artifactId, id))
				.run();
			database
				.delete(schema.artifacts)
				.where(eq(schema.artifacts.id, id))
				.run();
		});
	});
	it.each([defaultCache(), namedCache('builds')])(
		'serves a live listing in $kind',
		(scope) =>
			withoutAlarmArming(async () => {
				await seedListing(scope);
				const response = await currentServer().fetch(listingRequest(scope));
				expect({
					status: response.status,
					contentType: response.headers.get('content-type'),
					body: await response.text()
				}).toStrictEqual({
					status: 200,
					contentType: 'application/json',
					body: listing
				});
			})
	);
	it.each(['HEAD', 'conditional'] as const)(
		'serves %s using metadata without opening the body',
		(read) =>
			withoutAlarmArming(async () => {
				const fixture = await seedListing();
				await runInDurableObject(currentServer(), async (instance) => {
					const get = vi.spyOn(instance.context.env.BLOBS, 'get');
					try {
						const response = await new NarListingReadService(
							instance.context
						).serve(
							listingRequest(
								defaultCache(),
								read === 'HEAD'
									? { method: 'HEAD' }
									: {
											headers: {
												'if-none-match': `W/"${fixture.artifact.digest}"`
											}
										}
							),
							defaultCache(),
							hash
						);
						expect({
							status: response.status,
							body: await response.text(),
							etag: response.headers.get('etag'),
							size: response.headers.get('content-length'),
							cacheControl: response.headers.get('cache-control'),
							gets: get.mock.calls.length
						}).toStrictEqual({
							status: read === 'HEAD' ? 200 : 304,
							body: '',
							etag: `"${fixture.artifact.digest}"`,
							size: String(fixture.artifact.size),
							cacheControl: 'no-store',
							gets: 0
						});
					} finally {
						get.mockRestore();
					}
				});
			})
	);
	it.each(unavailable)('refuses a listing with %s', (change) =>
		withoutAlarmArming(async () => {
			const fixture = await seedListing();
			await runInDurableObject(currentServer(), async (instance) => {
				await invalidate(instance.context, fixture, change);
				const response = await new NarListingReadService(
					instance.context
				).serve(listingRequest(), defaultCache(), hash);
				expect({
					status: response.status,
					cacheControl: response.headers.get('cache-control')
				}).toStrictEqual({ status: 404, cacheControl: 'no-store' });
			});
		})
	);
	it.each(['head', 'get'] as const)(
		'revalidates after %s when publication authority changes',
		(phase) =>
			withoutAlarmArming(async () => {
				const fixture = await seedListing();
				await runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					const originalHead = context.env.BLOBS.head.bind(context.env.BLOBS);
					const originalGet = context.env.BLOBS.get.bind(context.env.BLOBS);
					const head = vi
						.spyOn(context.env.BLOBS, 'head')
						.mockImplementation(async (key) => {
							const value = await originalHead(key);
							if (phase === 'head') {
								await invalidate(context, fixture, 'revoked-nar');
							}
							return value;
						});
					const get = vi
						.spyOn(context.env.BLOBS, 'get')
						.mockImplementation(async (key, options) => {
							const value =
								options === undefined
									? await originalGet(key)
									: await originalGet(key, options);
							if (phase === 'get') {
								await invalidate(context, fixture, 'missing-parent');
							}
							return value;
						});
					try {
						await expect(
							new NarListingReadService(context).serve(
								listingRequest(),
								defaultCache(),
								hash
							)
						).rejects.toBeInstanceOf(ArtifactReadChangedError);
						expect({
							heads: head.mock.calls.length,
							gets: get.mock.calls.length
						}).toStrictEqual({ heads: 1, gets: phase === 'head' ? 0 : 1 });
					} finally {
						head.mockRestore();
						get.mockRestore();
					}
				});
			}, fixtureWorkerServer())
	);
	it('refuses a conditional read after the cache read policy changes', () =>
		withoutAlarmArming(async () => {
			await seedListing();
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const original = context.env.BLOBS.head.bind(context.env.BLOBS);
				const head = vi
					.spyOn(context.env.BLOBS, 'head')
					.mockImplementation(async (key) => {
						const object = await original(key);
						await context.d1
							.update(d1Schema.cacheLifecycle)
							.set({ readRevision: cacheReadRevisionSchema.parse(2) });
						return object;
					});
				try {
					const request = listingRequest(defaultCache(), {
						headers: { 'if-none-match': '*' }
					});
					const read = new NarListingReadService(context).serve(
						request,
						defaultCache(),
						hash
					);
					await expect(read).rejects.toBeInstanceOf(ArtifactReadChangedError);
				} finally {
					head.mockRestore();
				}
			});
		}));

	it('authenticates private listing reads through the Worker', () =>
		withoutAlarmArming(async () => {
			const scope = namedCache('private-builds');
			await seedListing(scope, true, 'private');
			const denied = await readFetch(cacheScopedPath(scope, `/${hash}.ls`));
			const allowed = await readFetch(cacheScopedPath(scope, `/${hash}.ls`), {
				headers: { authorization: `Basic ${btoa('alice:secret')}` }
			});
			expect({
				denied: denied.status,
				allowed: allowed.status,
				body: await allowed.text()
			}).toStrictEqual({ denied: 401, allowed: 200, body: listing });
		}));
	it.each(
		(['public', 'private'] as const).flatMap((access) =>
			(['GET', 'HEAD', 'conditional'] as const).map((read) => ({
				access,
				read
			}))
		)
	)('serves $read through a $access reuse view', ({ access, read }) =>
		withoutAlarmArming(async () => {
			const scope = namedCache(`${access}-builds`);
			const fixture = await seedListing(scope, true, access);
			await setView(
				[{ kind: 'named', name: `${access}-builds` }],
				'reuse',
				access
			);
			const headers = new Headers();
			if (access === 'private') {
				headers.set('authorization', `Basic ${btoa('alice:secret')}`);
			}
			if (read === 'conditional') {
				headers.set('if-none-match', `W/"${fixture.artifact.digest}"`);
			}
			const get = await runInDurableObject(fixtureWorkerServer(), (instance) =>
				vi.spyOn(instance.context.env.BLOBS, 'get')
			);
			let response: Response;
			let gets: number;
			try {
				response = await readFetch(`/reuse/reuse/${hash}.ls`, {
					headers,
					method: read === 'HEAD' ? 'HEAD' : 'GET'
				});
				gets = get.mock.calls.length;
			} finally {
				get.mockRestore();
			}
			expect({
				status: response.status,
				body: await response.text(),
				gets,
				etag: response.headers.get('etag'),
				cacheControl: response.headers.get('cache-control')
			}).toStrictEqual({
				status: read === 'conditional' ? 304 : 200,
				body: read === 'GET' ? listing : '',
				gets: read === 'GET' ? 1 : 0,
				etag: `"${fixture.artifact.digest}"`,
				cacheControl: 'no-store'
			});
		}, fixtureWorkerServer())
	);
	it('uses an agreeing source when the first selected cache has no listing', () =>
		withoutAlarmArming(async () => {
			const empty = namedCache('no-listing');
			await putWorkerTestCache(await initialiseViaWorker(), empty);
			const fixture = await seedListing(namedCache('builds'), true);
			await pushPathToTenant(
				fixtureTenant,
				fixture.token,
				fixture.metadata,
				fixture.nar,
				empty
			);
			await setView([
				{ kind: 'named', name: 'no-listing' },
				{ kind: 'named', name: 'builds' }
			]);
			const response = await readFetch(`/reuse/reuse/${hash}.ls`);
			expect({
				status: response.status,
				body: await response.text()
			}).toStrictEqual({ status: 200, body: listing });
		}, fixtureWorkerServer()));

	it('refuses a private reuse view without its read credential', () =>
		withoutAlarmArming(async () => {
			await seedListing(namedCache('private-builds'), true, 'private');
			await setView(
				[{ kind: 'named', name: 'private-builds' }],
				'reuse',
				'private'
			);
			const response = await readFetch(`/reuse/reuse/${hash}.ls`);
			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control')
			}).toStrictEqual({ status: 401, cacheControl: 'no-store' });
		}, fixtureWorkerServer()));
	it('refuses a listing when selected caches disagree on its NAR', () =>
		withoutAlarmArming(async () => {
			const fixture = await seedListing(namedCache('builds'), true);
			const other = namedCache('other');
			await putWorkerTestCache(fixture.token, other);
			const nar = await verifiableNar('conflicting-listing-source');
			await pushPathToTenant(
				fixtureTenant,
				fixture.token,
				uploadMetadata({
					storePathHash: hash,
					narHash: nar.narHash,
					narSize: nar.narSize,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength
				}),
				nar,
				other
			);
			await setView([
				{ kind: 'named', name: 'builds' },
				{ kind: 'named', name: 'other' }
			]);
			const response = await readFetch(`/reuse/reuse/${hash}.ls`);
			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control')
			}).toStrictEqual({ status: 404, cacheControl: 'no-store' });
		}, fixtureWorkerServer()));
	it.each(['view revision', 'candidate generation'] as const)(
		'refuses a conditional listing after the %s changes during the object read',
		(change) =>
			withoutAlarmArming(async () => {
				const fixture = await seedListing(namedCache('builds'), true);
				const otherName =
					change === 'view revision' ? 'view-agreeing' : 'generation-agreeing';
				const other = namedCache(otherName);
				await putWorkerTestCache(fixture.token, other);
				await pushPathToTenant(
					fixtureTenant,
					fixture.token,
					fixture.metadata,
					fixture.nar,
					other
				);
				await setView([
					{ kind: 'named', name: 'builds' },
					{ kind: 'named', name: otherName }
				]);
				await runInDurableObject(fixtureWorkerServer(), async (instance) => {
					const context = instance.context;
					const original = context.env.BLOBS.head.bind(context.env.BLOBS);
					const head = vi
						.spyOn(context.env.BLOBS, 'head')
						.mockImplementation(async (key) => {
							const object = await original(key);
							if (
								key ===
								casObjectKey(
									fixture.artifact.digest,
									fixture.artifact.incarnation
								)
							) {
								if (change === 'candidate generation') {
									const cache = context.cacheRepository.require(other);
									context.db
										.update(schema.narInfos)
										.set({
											generation: narInfoGenerationSchema.parse(
												fixture.parentGeneration + 1
											)
										})
										.where(eq(schema.narInfos.cacheId, cache.id))
										.run();
									return object;
								}
								const view = context.db.select().from(schema.reuseViews).get();
								if (view === undefined) {
									throw new Error('The fixture reuse view is missing');
								}
								context.db
									.update(schema.reuseViews)
									.set({
										revision: reuseViewRevisionSchema.parse(view.revision + 1)
									})
									.where(eq(schema.reuseViews.name, view.name))
									.run();
							}
							return object;
						});
					try {
						const response = await instance.fetch(
							new Request(`https://cupboard.test/reuse/reuse/${hash}.ls`, {
								headers: { 'if-none-match': '*' }
							})
						);
						expect({
							status: response.status,
							retryAfter: response.headers.get('retry-after'),
							cacheControl: response.headers.get('cache-control')
						}).toStrictEqual({
							status: 503,
							retryAfter: '1',
							cacheControl: 'no-store'
						});
					} finally {
						head.mockRestore();
					}
				});
			}, fixtureWorkerServer())
	);
});
