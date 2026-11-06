import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheScope,
	narInfoGenerationSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	createPublicationRequestId,
	type PublicationCaptureBeginRequest,
	publicationCaptureBeginRequestSchema,
	type PublicationCapturePageRequest,
	publicationDigestSchema,
	publicationManifestIdentity,
	publicationManifestLeafIdentity,
	publicationOperationIdSchema,
	publicationRequestIdSchema,
	type PublicationResultIdentity,
	publicationResultIdentitySchema
} from '@cupboard/protocol/publication-manifests';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	authorisedWorkerFetch,
	cacheScopedPath,
	currentNarObjectKey,
	fixtureWorkerServer,
	initialiseViaWorker,
	isNarInfoSignatureValid,
	namedCache,
	resetTestServer,
	restartTestServers,
	withoutAlarmArming
} from '../test-support.ts';

import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import { PublicationManifestAuthority } from './publication-manifest-authority.ts';
import { PublicationManifestAvailabilityStore } from './publication-manifest-availability-store.ts';
import { PublicationManifestCaptureService } from './publication-manifest-capture.ts';
import { captureProgressSchema } from './publication-manifest-capture-progress.ts';
import { PublicationManifestCleanup } from './publication-manifest-cleanup.ts';
import { PublicationManifestRepository } from './publication-manifest-repository.ts';
import { committedPath } from './reuse-view-read.test-support.ts';
import { currentRowBudgetMeter, withRowBudget } from './row-budget.ts';

const fixtureCounter = { next: 0 };
interface Fixture {
	scope: CacheScope;
	grants: AuthorizationDetails;
	result: PublicationResultIdentity;
	request: PublicationCaptureBeginRequest;
}
async function fixture(): Promise<Fixture> {
	fixtureCounter.next += 1;
	const scope = namedCache(`capture-${String(fixtureCounter.next)}`);
	await committedPath(`capture-${String(fixtureCounter.next)}`, scope);
	return runInDurableObject(fixtureWorkerServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(scope);
		const row = instance.context.db
			.select()
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, cache.id))
			.get();
		if (row === undefined) {
			throw new Error('Missing fixture');
		}
		const result = publicationResultIdentitySchema.parse({
			cache: scope,
			cacheGeneration: cache.generation,
			storePath: row.storePath,
			narHash: row.narHash,
			generation: row.generation
		});
		const request = publicationCaptureBeginRequestSchema.parse({
			result: {
				storePath: row.storePath,
				narHash: row.narHash,
				generation: row.generation
			},
			expectedCacheGeneration: cache.generation,
			requestId: crypto.randomUUID(),
			origin: 'build-selection',
			memberCount: 1
		});
		const grants = authorizationDetailsSchema.parse([
			{ type: 'cupboard_cache', cache: scope, actions: ['upload:commit'] }
		]);
		return { scope, grants, result, request };
	});
}
function begin(f: Fixture, request = f.request) {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		new PublicationManifestCaptureService(instance.context).captureBegin(
			f.scope,
			f.grants,
			request
		)
	);
}
function page(f: Fixture, request: PublicationCapturePageRequest) {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		new PublicationManifestCaptureService(instance.context).capturePage(
			f.scope,
			f.grants,
			request
		)
	);
}
function counts(f: Fixture) {
	return runInDurableObject(fixtureWorkerServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(f.scope);
		const operations = instance.context.db
			.select()
			.from(schema.publicationManifestOperations)
			.where(eq(schema.publicationManifestOperations.cacheId, cache.id))
			.all();
		const ids = new Set(operations.map((operation) => operation.id));
		return {
			operations,
			pages: instance.context.db
				.select()
				.from(schema.publicationManifestOperationPages)
				.all()
				.filter((page) => ids.has(page.operationId)),
			associations: instance.context.db
				.select()
				.from(schema.resultPublications)
				.where(eq(schema.resultPublications.cacheId, cache.id))
				.all()
		};
	});
}
async function staging(f: Fixture) {
	const response = await begin(f);
	if (response.kind !== 'staging') {
		throw new Error('Expected staging');
	}
	return response;
}
async function record(f: Fixture) {
	const identity = await publicationManifestIdentity([
		{ storePath: f.result.storePath, narHash: f.result.narHash }
	]);
	return runInDurableObject(fixtureWorkerServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(f.scope);
		instance.context.db.transaction((tx) => {
			tx.insert(schema.publicationManifests)
				.values({ digest: identity.digest, version: 1, memberCount: 1 })
				.run();
			tx.insert(schema.publicationManifestMembers)
				.values({
					digest: identity.digest,
					ordinal: 0,
					...identity.members[0],
					storePath: f.result.storePath,
					narHash: f.result.narHash,
					storePathHash: StorePath.hash(f.result.storePath)
				})
				.run();
			tx.insert(schema.resultPublications)
				.values({
					cacheId: cache.id,
					cacheGeneration: cache.generation,
					resultHash: StorePath.hash(f.result.storePath),
					resultPath: f.result.storePath,
					resultGeneration: f.result.generation,
					resultNarHash: f.result.narHash,
					digest: identity.digest,
					materialisationId: f.request.requestId,
					origin: 'legacy-selection',
					complete: true
				})
				.run();
			tx.insert(schema.resultPublicationMembers)
				.values({
					cacheId: cache.id,
					cacheGeneration: cache.generation,
					resultHash: StorePath.hash(f.result.storePath),
					resultGeneration: f.result.generation,
					materialisationId: f.request.requestId,
					memberHash: StorePath.hash(f.result.storePath),
					memberPath: f.result.storePath,
					memberNarHash: f.result.narHash,
					memberGeneration: f.result.generation
				})
				.run();
		});
		return {
			result: f.result,
			digest: identity.digest,
			memberCount: 1,
			origin: 'legacy-selection' as const
		};
	});
}

describe('PublicationManifestCaptureService intake', () => {
	beforeEach(resetTestServer);
	for (const timing of ['before', 'during'] as const) {
		it(`rejects a capture proof observed ${timing} mutation even after acknowledged drain`, async () => {
			await withoutAlarmArming(async () => {
				const f = await fixture();
				const operation = await staging(f);
				await runInDurableObject(fixtureWorkerServer(), async (instance) => {
					const cache = instance.context.cacheRepository.require(f.scope);
					const availability = new PublicationManifestAvailabilityStore(
						instance.context.db
					);
					const version = {
						cacheId: cache.id,
						cacheGeneration: cache.generation,
						storePathHash: StorePath.hash(f.result.storePath),
						storePath: f.result.storePath,
						narHash: f.result.narHash,
						generation: f.result.generation
					};
					const intent =
						timing === 'during'
							? availability.begin(version, 'revoke')
							: undefined;
					const authority = new PublicationManifestAuthority(instance.context);
					const requireServable = authority.requireServable.bind(authority);
					const probe = vi
						.spyOn(PublicationManifestAuthority.prototype, 'requireServable')
						.mockImplementationOnce(async (snapshot) => {
							if (intent !== undefined) {
								expect(snapshot.availability.unresolved).toBe(true);
								availability.acknowledge(intent.revision);
								availability.drainPage(intent.revision);
								await requireServable(snapshot);
								return;
							}
							await requireServable(snapshot);
							await new PathReadAuthorityService(instance.context).revoke(
								cache,
								[version]
							);
						});
					try {
						await expect(
							new PublicationManifestCaptureService(
								instance.context
							).capturePage(f.scope, f.grants, {
								operationId: operation.operationId,
								page: 0,
								members: [f.request.result]
							})
						).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
						expect(availability.nextIntent()).toBeUndefined();
						expect(
							instance.context.db
								.select()
								.from(schema.resultPublicationMembers)
								.all()
						).toHaveLength(0);
						expect(
							instance.context.db
								.select()
								.from(schema.publicationManifestOperationPages)
								.all()
						).toHaveLength(0);
					} finally {
						probe.mockRestore();
					}
				});
			}, fixtureWorkerServer());
		});
	}

	it.each(['before', 'during'] as const)(
		'rejects local intake observed %s mutation even after bounded drain',
		async (timing) => {
			await withoutAlarmArming(async () => {
				const f = await fixture();
				const operation = await staging(f);
				await runInDurableObject(fixtureWorkerServer(), async (instance) => {
					const cache = instance.context.cacheRepository.require(f.scope);
					const row = instance.context.db
						.select()
						.from(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, cache.id))
						.get();
					if (row === undefined) {
						throw new Error('Missing local identity');
					}
					const mutate = () => {
						instance.context.db
							.delete(schema.narInfos)
							.where(eq(schema.narInfos.cacheId, cache.id))
							.run();
						instance.context.db.insert(schema.narInfos).values(row).run();
					};
					if (timing === 'during') {
						mutate();
					}
					const authority = new PublicationManifestAuthority(instance.context);
					const original = authority.requireServable.bind(authority);
					const probe = vi
						.spyOn(PublicationManifestAuthority.prototype, 'requireServable')
						.mockImplementationOnce(async (snapshot) => {
							await original(snapshot);
							if (timing === 'before') {
								mutate();
							}
							withRowBudget(() =>
								new PublicationManifestCleanup(instance.context.db).collect(
									isoTimestamp(new Date()),
									64
								)
							);
						});
					try {
						await expect(
							new PublicationManifestCaptureService(
								instance.context
							).capturePage(f.scope, f.grants, {
								operationId: operation.operationId,
								page: 0,
								members: [f.request.result]
							})
						).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
						expect(
							instance.context.db
								.select()
								.from(schema.resultPublicationMembers)
								.where(
									eq(
										schema.resultPublicationMembers.materialisationId,
										operation.operationId
									)
								)
								.all()
						).toEqual([]);
						expect(
							instance.context.db
								.select()
								.from(schema.publicationManifestOperationPages)
								.where(
									eq(
										schema.publicationManifestOperationPages.operationId,
										operation.operationId
									)
								)
								.all()
						).toEqual([]);
						expect(
							new PublicationManifestAvailabilityStore(
								instance.context.db
							).nextIntent(false)
						).toBeUndefined();
					} finally {
						probe.mockRestore();
					}
				});
			}, fixtureWorkerServer());
		}
	);

	it('enforces manifest/page limits and rejects duplicate full paths without storing pages', async () => {
		const f = await fixture();
		await expect(
			begin(f, { ...f.request, memberCount: 100_001 })
		).rejects.toMatchObject({
			code: 'PUBLICATION_LIMIT_EXCEEDED',
			data: { limit: 'total-members', maximum: 100_000 }
		});
		const operation = await staging(f);
		await expect(
			page(f, {
				operationId: operation.operationId,
				page: 0,
				members: Array.from({ length: 65 }, () => f.request.result)
			})
		).rejects.toMatchObject({
			code: 'PUBLICATION_LIMIT_EXCEEDED',
			data: { limit: 'page-members', maximum: 64 }
		});
		await expect(
			page(f, {
				operationId: operation.operationId,
				page: 0,
				members: [f.request.result, f.request.result]
			})
		).rejects.toThrow();
		const state = await counts(f);
		expect(state.pages).toHaveLength(0);
	});
	it('rechecks commit authority for operation IDs rather than treating them as bearer capabilities', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await expect(
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestCaptureService(instance.context).capturePage(
					f.scope,
					[],
					{
						operationId: operation.operationId,
						page: 0,
						members: [f.request.result]
					}
				)
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const state = await counts(f);
		expect(state.pages).toHaveLength(0);
	});
	it('revalidates the exact recorded association for promotion, not just its accepted result', async () => {
		const f = await fixture();
		const publication = await record(f);
		const wrongDigest = publicationDigestSchema.parse('a'.repeat(64));
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const authority = new PublicationManifestAuthority(instance.context);
			expect(() =>
				authority.resolveRecorded(f.scope, f.grants, {
					...publication,
					digest: wrongDigest
				})
			).toThrow(
				expect.objectContaining({ code: 'PUBLICATION_RESULT_CHANGED' })
			);
			const snapshot = authority.resolveRecorded(
				f.scope,
				f.grants,
				publication
			);
			instance.context.db
				.delete(schema.resultPublications)
				.where(
					eq(schema.resultPublications.resultPath, publication.result.storePath)
				)
				.run();
			expect(() => authority.revalidate(snapshot, f.grants)).toThrow(
				expect.objectContaining({ code: 'PUBLICATION_RESULT_CHANGED' })
			);
		});
	});
	it('durably replays begin and pages across restart without claiming completion', async () => {
		const f = await fixture();
		const operation = await staging(f);
		const request = {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		};
		expect(await page(f, request)).toStrictEqual({
			operationId: operation.operationId,
			page: 0,
			acceptedCount: 1
		});
		await restartTestServers();
		expect(await begin(f)).toStrictEqual(operation);
		expect(await page(f, request)).toStrictEqual({
			operationId: operation.operationId,
			page: 0,
			acceptedCount: 1
		});
		const state = await counts(f);
		expect({
			operations: state.operations.length,
			pages: state.pages.length,
			associations: state.associations.length,
			state: state.operations[0]?.state,
			cursor: state.operations[0]?.cursor
		}).toStrictEqual({
			operations: 1,
			pages: 1,
			associations: 0,
			state: 'pending',
			cursor: 1
		});
	});
	it('rejects changed immutable intent and page payload', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await expect(
			begin(f, { ...f.request, origin: 'legacy-selection' })
		).rejects.toMatchObject({ code: 'PUBLICATION_IDEMPOTENCY_CONFLICT' });
		const request = {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		};
		await page(f, request);
		await expect(
			page(f, {
				...request,
				members: [
					{
						...f.request.result,
						generation: narInfoGenerationSchema.parse(f.result.generation + 1)
					}
				]
			})
		).rejects.toMatchObject({ code: 'PUBLICATION_IDEMPOTENCY_CONFLICT' });
	});
	it('enforces contiguous page numbers and exact declared count', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await expect(
			page(f, {
				operationId: operation.operationId,
				page: 1,
				members: [f.request.result]
			})
		).rejects.toMatchObject({ code: 'PUBLICATION_INVALID_PAGE' });
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		await expect(
			page(f, {
				operationId: operation.operationId,
				page: 1,
				members: [f.request.result]
			})
		).rejects.toMatchObject({ code: 'PUBLICATION_INVALID_PAGE' });
		const state = await counts(f);
		expect(state.pages).toHaveLength(1);
	});
	it('rejects expired operation replay and changed result generations', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture();
			const operation = await staging(f);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				instance.context.db
					.update(schema.publicationManifestOperations)
					.set({ expiresAt: isoTimestamp(new Date(0)) })
					.where(
						eq(schema.publicationManifestOperations.id, operation.operationId)
					)
					.run();
			});
			await expect(begin(f)).rejects.toMatchObject({ code: 'GONE' });
			await expect(
				page(f, {
					operationId: operation.operationId,
					page: 0,
					members: [f.request.result]
				})
			).rejects.toMatchObject({ code: 'GONE' });
			const newRequestId = publicationRequestIdSchema.parse(
				crypto.randomUUID()
			);
			await expect(
				begin(f, {
					...f.request,
					requestId: newRequestId,
					result: {
						...f.request.result,
						generation: narInfoGenerationSchema.parse(f.result.generation + 1)
					}
				})
			).rejects.toMatchObject({ code: 'PUBLICATION_RESULT_CHANGED' });
		}, fixtureWorkerServer());
	});
	it('rolls back page and progress together if the local write fails', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			instance.context.db.run(
				sql`CREATE TRIGGER capture_test_abort BEFORE UPDATE ON publication_manifest_operation BEGIN SELECT RAISE(ABORT,'test rollback'); END`
			);
		});
		await expect(
			page(f, {
				operationId: operation.operationId,
				page: 0,
				members: [f.request.result]
			})
		).rejects.toThrow();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			instance.context.db.run(sql`DROP TRIGGER capture_test_abort`);
		});
		const state = await counts(f);
		expect(state.pages).toHaveLength(0);
		expect(state.operations[0]?.cursor).toBe(0);
	});
	it('returns the already recorded winner to competing captures without merging origin or content', async () => {
		const f = await fixture();
		const winner = await record(f);
		const competingRequestId = publicationRequestIdSchema.parse(
			crypto.randomUUID()
		);
		const responses = await Promise.all([
			begin(f),
			begin(f, {
				...f.request,
				requestId: competingRequestId,
				memberCount: 2
			})
		]);
		expect(responses).toStrictEqual([
			{ kind: 'existing', publication: winner },
			{ kind: 'existing', publication: winner }
		]);
		await expect(
			begin(f, { ...f.request, memberCount: 2 })
		).rejects.toMatchObject({ code: 'PUBLICATION_IDEMPOTENCY_CONFLICT' });
		const state = await counts(f);
		expect(state.associations).toHaveLength(1);
	});
	it('rejects a result changed between the off-gate probe and durable intake', async () => {
		const f = await fixture();
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const objects = new NarInfoObjectsService(instance.context);
			const original = objects.servableNarInfoVersions.bind(objects);
			const probe = vi
				.spyOn(NarInfoObjectsService.prototype, 'servableNarInfoVersions')
				.mockImplementation(async (cache, hashes) => {
					const served = await original(cache, hashes);
					instance.context.db
						.update(schema.narInfos)
						.set({
							generation: narInfoGenerationSchema.parse(f.result.generation + 1)
						})
						.where(eq(schema.narInfos.cacheId, cache.id))
						.run();
					return served;
				});
			try {
				await expect(
					new PublicationManifestCaptureService(instance.context).captureBegin(
						f.scope,
						f.grants,
						f.request
					)
				).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
			} finally {
				probe.mockRestore();
			}
		});
		const state = await counts(f);
		expect(state.operations).toHaveLength(0);
	});
	it('never reports unavailable canonical bytes as an association miss', async () => {
		const f = await fixture();
		await env.BLOBS.delete(await currentNarObjectKey(f.result.narHash));
		await expect(begin(f)).rejects.toMatchObject({
			code: 'SERVICE_UNAVAILABLE'
		});
		await expect(
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestRepository(instance.context).lookup(
					f.scope,
					f.grants,
					{
						source: {
							cache: f.scope,
							expectedCacheGeneration: f.result.cacheGeneration
						},
						results: [f.request.result]
					}
				)
			)
		).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
		const state = await counts(f);
		expect(state.operations).toHaveLength(0);
	});
	it('reads recorded certificates without availability probes or member enumeration', async () => {
		const f = await fixture();
		const publication = await record(f);
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const probe = vi
				.spyOn(NarInfoObjectsService.prototype, 'servableNarInfoVersions')
				.mockRejectedValue(
					new Error('Warm lookup must not probe members or result bytes')
				);
			try {
				const response = await new PublicationManifestRepository(
					instance.context
				).lookup(f.scope, f.grants, {
					source: {
						cache: f.scope,
						expectedCacheGeneration: f.result.cacheGeneration
					},
					results: [f.request.result]
				});
				expect(response).toStrictEqual({
					entries: [{ kind: 'recorded', publication, complete: true }]
				});
				expect(probe).not.toHaveBeenCalled();
			} finally {
				probe.mockRestore();
			}
		});
	});
	it('distinguishes a missing association from unavailable content and reads an existing certificate', async () => {
		const f = await fixture();
		const lookup = () =>
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestRepository(instance.context).lookup(
					f.scope,
					f.grants,
					{
						source: {
							cache: f.scope,
							expectedCacheGeneration: f.result.cacheGeneration
						},
						results: [f.request.result]
					}
				)
			);
		expect(await lookup()).toStrictEqual({
			entries: [{ kind: 'missing', result: f.result }]
		});
		const publication = await record(f);
		expect(await lookup()).toStrictEqual({
			entries: [{ kind: 'recorded', publication, complete: true }]
		});
	});
});

describe('PublicationManifestCaptureService bounded seal', () => {
	beforeEach(resetTestServer);
	it('stages private candidates, freezes intake, resumes and returns captured metadata, never an ensure certificate', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		const seal = () =>
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestCaptureService(instance.context).captureSeal(
					f.scope,
					f.grants,
					{ operationId: operation.operationId }
				)
			);
		const status = () =>
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestCaptureService(instance.context).captureStatus(
					f.scope,
					f.grants,
					{ operationId: operation.operationId }
				)
			);
		expect(await seal()).toStrictEqual({
			kind: 'pending',
			operationId: operation.operationId
		});
		const frozen = await counts(f);
		expect(frozen.operations[0]?.phase).toBe('sealing');
		expect(await status()).toStrictEqual({
			kind: 'pending',
			operationId: operation.operationId
		});
		expect(await counts(f)).toStrictEqual(frozen);
		await restartTestServers();
		let response = await seal();
		for (let step = 0; response.kind === 'pending' && step < 8; step += 1) {
			response = await seal();
		}
		expect(response).toMatchObject({
			kind: 'captured',
			association: 'created',
			publication: { result: f.result, memberCount: 1 }
		});
		expect(response).not.toHaveProperty('publication.materialisation');
		expect(await status()).toStrictEqual(response);
		expect(await seal()).toStrictEqual(response);
	});
	it('rejects cross-page duplicate proofs atomically and refuses a set without its result', async () => {
		const f = await fixture();
		f.request = { ...f.request, memberCount: 2 };
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		await expect(
			page(f, {
				operationId: operation.operationId,
				page: 1,
				members: [f.request.result]
			})
		).rejects.toMatchObject({ code: 'PUBLICATION_INVALID_PAGE' });
		const state = await counts(f);
		expect(state.pages).toHaveLength(1);
		await expect(
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestCaptureService(instance.context).captureSeal(
					f.scope,
					f.grants,
					{ operationId: operation.operationId }
				)
			)
		).rejects.toMatchObject({ code: 'PUBLICATION_INVALID_PAGE' });
	});
});

function seal(
	f: Fixture,
	operationId: PublicationCapturePageRequest['operationId']
) {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		new PublicationManifestCaptureService(instance.context).captureSeal(
			f.scope,
			f.grants,
			{ operationId }
		)
	);
}
async function finish(
	f: Fixture,
	operationId: PublicationCapturePageRequest['operationId']
) {
	for (let step = 0; step < 30; step += 1) {
		const response = await seal(f, operationId);
		if (response.kind === 'captured') {
			return response;
		}
	}
	throw new Error('Bounded continuation failed to finish');
}
async function localMembers(f: Fixture, length: number) {
	return runInDurableObject(fixtureWorkerServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(f.scope);
		const row = instance.context.db
			.select()
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, cache.id))
			.get();
		if (row === undefined) {
			throw new Error('Missing local fixture');
		}
		const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
		const versions = [f.request.result];
		for (let index = 0; index < length; index += 1) {
			const suffix =
				alphabet.charAt(Math.floor(index / 32)) + alphabet.charAt(index % 32);
			const hash = storePathHashSchema.parse(
				`333333333333333333333333333333${suffix}`
			);
			const storePath = storePathSchema.parse(
				`/nix/store/${hash}-capture-member`
			);
			instance.context.db
				.insert(schema.narInfos)
				.values({ ...row, storePathHash: hash, storePath })
				.run();
			versions.push({
				storePath,
				narHash: row.narHash,
				generation: row.generation
			});
		}
		return versions;
	});
}
async function localPage(f: Fixture, request: PublicationCapturePageRequest) {
	return runInDurableObject(fixtureWorkerServer(), async (instance) => {
		// Volume cases isolate the local bounded proof pipeline. Real acceptance,
		// D1 and R2 refusal cases are exercised independently above.
		const probe = vi
			.spyOn(PublicationManifestAuthority.prototype, 'requireServable')
			.mockResolvedValue();
		try {
			return await new PublicationManifestCaptureService(
				instance.context
			).capturePage(f.scope, f.grants, request);
		} finally {
			probe.mockRestore();
		}
	});
}

describe('PublicationManifestCaptureService candidate proof and finalisation', () => {
	beforeEach(resetTestServer);
	it.each(['narSize', 'references'] as const)(
		'refuses a current signed %s mismatch before staging a capture proof',
		async (change) => {
			await withoutAlarmArming(async () => {
				const f = await fixture();
				const operation = await staging(f);
				const accepted = await runInDurableObject(
					fixtureWorkerServer(),
					(instance) => {
						const cache = instance.context.cacheRepository.require(f.scope);
						return {
							key: new NarInfoObjectsService(instance.context).objectKey(
								cache,
								StorePath.hash(f.result.storePath)
							),
							row: instance.context.db
								.select()
								.from(schema.narInfos)
								.where(eq(schema.narInfos.cacheId, cache.id))
								.get(),
							signingKey: instance.context.db
								.select()
								.from(schema.signingKeys)
								.get()
						};
					}
				);
				const published = await env.BLOBS.get(accepted.key);
				if (
					published === null ||
					accepted.row === undefined ||
					accepted.signingKey === undefined
				) {
					throw new Error('Missing real publication');
				}
				const original = NarInfo.parse(await published.text());
				expect(
					await isNarInfoSignatureValid(original, accepted.signingKey.publicKey)
				).toBe(true);
				expect(original.toFields()).toStrictEqual({
					...original.toFields(),
					storePath: accepted.row.storePath,
					narHash: accepted.row.narHash,
					narSize: accepted.row.narSize,
					references: JSON.parse(accepted.row.referencesJson) as unknown,
					sigs: JSON.parse(accepted.row.sigsJson) as unknown
				});
				expect(published.customMetadata).toStrictEqual({
					generation: String(accepted.row.generation),
					narHash: accepted.row.narHash,
					narUrl: original.url,
					signatureGeneration: String(
						accepted.row.pendingSignatureGeneration ??
							accepted.row.signatureGeneration
					)
				});
				const changed = NarInfo.fromFields({
					...original.toFields(),
					...(change === 'narSize'
						? { narSize: original.narSize + 1 }
						: { references: ['22222222222222222222222222222222-changed'] })
				});
				expect(changed.sigs).toStrictEqual(original.sigs);
				expect(
					await isNarInfoSignatureValid(changed, accepted.signingKey.publicKey)
				).toBe(false);
				const text = changed.render();
				await env.BLOBS.put(accepted.key, text, {
					customMetadata: published.customMetadata,
					httpMetadata: published.httpMetadata
				});
				const state = () =>
					runInDurableObject(fixtureWorkerServer(), async (instance) => {
						const { db, d1 } = instance.context;
						return {
							paths: db.select().from(schema.narInfos).all(),
							grace: db.select().from(schema.retentionGrace).all(),
							roots: db.select().from(schema.retentionRoots).all(),
							targets: db.select().from(schema.retentionRootTargets).all(),
							receipts: db.select().from(schema.confirmationReceipts).all(),
							proofs: db.select().from(schema.resultPublicationMembers).all(),
							manifests: db.select().from(schema.publicationManifests).all(),
							members: db
								.select()
								.from(schema.publicationManifestMembers)
								.all(),
							cardinalities: db
								.select()
								.from(schema.publicationManifestCardinalities)
								.all(),
							edges: await d1.select().from(d1Schema.blobReference).all(),
							usage: await d1.select().from(d1Schema.tenantUsage).all()
						};
					});
				const before = { capture: await counts(f), state: await state() };
				await expect(
					page(f, {
						operationId: operation.operationId,
						page: 0,
						members: [f.request.result]
					})
				).rejects.toMatchObject({
					name: 'CorruptNarInfoProjectionError',
					status: 409,
					reason: 'invalid-publication'
				});
				expect({
					capture: await counts(f),
					state: await state()
				}).toStrictEqual(before);
				const unchanged = await env.BLOBS.get(accepted.key);
				expect({
					text: await unchanged?.text(),
					metadata: unchanged?.customMetadata,
					httpMetadata: unchanged?.httpMetadata
				}).toStrictEqual({
					text,
					metadata: published.customMetadata,
					httpMetadata: published.httpMetadata
				});
			}, fixtureWorkerServer());
		}
	);

	it('cannot finalise a fresh capture for a physically renamed row with an unchanged served narinfo', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture();
			const renamed = storePathSchema.parse(`${f.result.storePath}-renamed`);
			const key = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) => {
					const cache = instance.context.cacheRepository.require(f.scope);
					instance.context.db
						.update(schema.narInfos)
						.set({ storePath: renamed })
						.where(eq(schema.narInfos.cacheId, cache.id))
						.run();
					const availability = new PublicationManifestAvailabilityStore(
						instance.context.db
					);
					expect(availability.nextIntent(false)?.kind).toBe('local');
					withRowBudget(() => availability.drain());
					expect(availability.nextIntent(false)).toBeUndefined();
					return new NarInfoObjectsService(instance.context).objectKey(
						cache,
						StorePath.hash(f.result.storePath)
					);
				}
			);
			const published = await env.BLOBS.get(key);
			const publishedBody = await published?.text();
			expect(publishedBody).toContain(`StorePath: ${f.result.storePath}\n`);
			f.result = { ...f.result, storePath: renamed };
			f.request = {
				...f.request,
				result: { ...f.request.result, storePath: renamed }
			};
			const state = () =>
				runInDurableObject(fixtureWorkerServer(), async (instance) => ({
					paths: instance.context.db.select().from(schema.narInfos).all(),
					grace: instance.context.db.select().from(schema.retentionGrace).all(),
					roots: instance.context.db.select().from(schema.retentionRoots).all(),
					targets: instance.context.db
						.select()
						.from(schema.retentionRootTargets)
						.all(),
					receipts: instance.context.db
						.select()
						.from(schema.confirmationReceipts)
						.all(),
					proofs: instance.context.db
						.select()
						.from(schema.resultPublicationMembers)
						.all(),
					manifests: instance.context.db
						.select()
						.from(schema.publicationManifests)
						.all(),
					members: instance.context.db
						.select()
						.from(schema.publicationManifestMembers)
						.all(),
					cardinalities: instance.context.db
						.select()
						.from(schema.publicationManifestCardinalities)
						.all(),
					edges: await instance.context.d1
						.select()
						.from(d1Schema.blobReference)
						.all(),
					usage: await instance.context.d1
						.select()
						.from(d1Schema.tenantUsage)
						.all()
				}));
			const before = { capture: await counts(f), state: await state() };
			await expect(
				(async () => {
					const operation = await staging(f);
					await page(f, {
						operationId: operation.operationId,
						page: 0,
						members: [f.request.result]
					});
					return finish(f, operation.operationId);
				})()
			).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
			expect({ capture: await counts(f), state: await state() }).toStrictEqual(
				before
			);
			const unchanged = await env.BLOBS.get(key);
			expect(await unchanged?.text()).toBe(publishedBody);
		}, fixtureWorkerServer());
	});

	it('refuses to pin a partially retired digest across reset, then recaptures after bounded retirement', async () => {
		const id = fixtureWorkerServer().id;
		ignoreAlarmDeliveries(id);
		try {
			const f = await fixture();
			const members = await localMembers(f, 64);
			f.request = { ...f.request, memberCount: members.length };
			const original = await staging(f);
			for (let pageNumber = 0; pageNumber < 2; pageNumber += 1) {
				await localPage(f, {
					operationId: original.operationId,
					page: pageNumber,
					members: members.slice(pageNumber * 64, (pageNumber + 1) * 64)
				});
			}
			const captured = await finish(f, original.operationId);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				instance.context.db
					.delete(schema.resultPublications)
					.where(
						eq(
							schema.resultPublications.materialisationId,
							original.operationId
						)
					)
					.run();
				instance.context.db
					.delete(schema.publicationManifestOperations)
					.where(
						eq(schema.publicationManifestOperations.id, original.operationId)
					)
					.run();
				const cleanup = new PublicationManifestCleanup(instance.context.db);
				for (let step = 0; step < 100; step += 1) {
					withRowBudget(() => cleanup.collect(isoTimestamp(new Date()), 64), 1);
					const proof = instance.context.db
						.select()
						.from(schema.publicationManifestCardinalities)
						.where(
							and(
								eq(schema.publicationManifestCardinalities.kind, 'portable'),
								eq(
									schema.publicationManifestCardinalities.id,
									captured.publication.digest
								)
							)
						)
						.get();
					if (proof?.valid === false) {
						break;
					}
				}
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestMembers)
						.where(
							eq(
								schema.publicationManifestMembers.digest,
								captured.publication.digest
							)
						)
						.all()
				).toHaveLength(1);
			});
			await restartTestServers();
			await runInDurableObject(fixtureWorkerServer(), (instance) =>
				instance.alarm()
			);
			f.request = {
				...f.request,
				requestId: publicationRequestIdSchema.parse(crypto.randomUUID())
			};
			const retry = await staging(f);
			for (let pageNumber = 0; pageNumber < 2; pageNumber += 1) {
				await localPage(f, {
					operationId: retry.operationId,
					page: pageNumber,
					members: members.slice(pageNumber * 64, (pageNumber + 1) * 64)
				});
			}
			await seal(f, retry.operationId);
			await seal(f, retry.operationId);
			await seal(f, retry.operationId);
			const before = await counts(f);
			await expect(seal(f, retry.operationId)).rejects.toMatchObject({
				code: 'SERVICE_UNAVAILABLE'
			});
			expect(await counts(f)).toEqual(before);
			expect(before.operations[0]?.candidateDigest).toBeNull();
			await restartTestServers();
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cleanup = new PublicationManifestCleanup(instance.context.db);
				withRowBudget(() => cleanup.collect(isoTimestamp(new Date()), 64));
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifests)
						.where(
							eq(
								schema.publicationManifests.digest,
								captured.publication.digest
							)
						)
						.all()
				).toEqual([]);
			});
			const recaptured = await finish(f, retry.operationId);
			expect(recaptured.publication).toEqual(captured.publication);
		} finally {
			deliverAlarms(id);
		}
	});

	it('fences staged local proofs through DELETE/reinsert, preserves a fresh pending observation and an unrelated selection', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture();
			const unrelated = await fixture();
			const healthy = await record(unrelated);
			const original = await staging(f);
			await page(f, {
				operationId: original.operationId,
				page: 0,
				members: [f.request.result]
			});
			const saved = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) => {
					const cache = instance.context.cacheRepository.require(f.scope);
					const row = instance.context.db
						.select()
						.from(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, cache.id))
						.get();
					if (row === undefined) {
						throw new Error('Missing result');
					}
					instance.context.db
						.delete(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, cache.id))
						.run();
					instance.context.db.insert(schema.narInfos).values(row).run();
					return instance.context.db
						.select()
						.from(schema.resultPublicationMembers)
						.where(
							eq(
								schema.resultPublicationMembers.materialisationId,
								original.operationId
							)
						)
						.all();
				}
			);
			await expect(seal(f, original.operationId)).rejects.toMatchObject({
				code: 'SERVICE_UNAVAILABLE'
			});
			f.request = {
				...f.request,
				requestId: publicationRequestIdSchema.parse(crypto.randomUUID())
			};
			const fresh = await staging(f);
			await page(f, {
				operationId: fresh.operationId,
				page: 0,
				members: [f.request.result]
			});
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const store = new PublicationManifestAvailabilityStore(
					instance.context.db
				);
				expect(store.nextIntent(false)?.kind).toBe('local');
				withRowBudget(() =>
					new PublicationManifestCleanup(instance.context.db).collect(
						isoTimestamp(new Date()),
						64
					)
				);
				expect(store.nextIntent(false)).toBeUndefined();
				expect(
					instance.context.db
						.select()
						.from(schema.resultPublicationMembers)
						.where(
							eq(
								schema.resultPublicationMembers.materialisationId,
								original.operationId
							)
						)
						.all()
				).toEqual(saved);
				const cache = instance.context.cacheRepository.require(unrelated.scope);
				expect(
					new PublicationManifestRepository(instance.context).association(
						cache,
						unrelated.result
					)
				).toEqual({ publication: healthy, complete: true });
			});
			await expect(seal(f, original.operationId)).rejects.toMatchObject({
				code: 'CONFLICT'
			});
			const recovered = await finish(f, fresh.operationId);
			const identity = await publicationManifestIdentity([
				{ storePath: f.result.storePath, narHash: f.result.narHash }
			]);
			expect(recovered.publication).toEqual({
				result: f.result,
				digest: identity.digest,
				memberCount: 1,
				origin: 'build-selection'
			});
		}, fixtureWorkerServer());
	});

	it('hashes global 64-member leaves independently of intake boundaries and publishes at most 64 canonical slots per step', async () => {
		const f = await fixture();
		const members = await localMembers(f, 65);
		f.request = { ...f.request, memberCount: members.length };
		const operation = await staging(f);
		const unordered = members.toReversed();
		await localPage(f, {
			operationId: operation.operationId,
			page: 0,
			members: unordered.slice(0, 31)
		});
		await localPage(f, {
			operationId: operation.operationId,
			page: 1,
			members: unordered.slice(31, 64)
		});
		await localPage(f, {
			operationId: operation.operationId,
			page: 2,
			members: unordered.slice(64)
		});
		const identity = await publicationManifestIdentity(
			members.map((member) => ({
				storePath: member.storePath,
				narHash: member.narHash
			}))
		);
		await seal(f, operation.operationId);
		await restartTestServers();
		await seal(f, operation.operationId);
		let state = await counts(f);
		expect(state.operations[0]?.cursor).toBe(64);
		expect(
			captureProgressSchema.options[0].parse(
				JSON.parse(state.operations[0]?.progressJson ?? 'null')
			).pageDigests
		).toHaveLength(1);
		await seal(f, operation.operationId);
		state = await counts(f);
		expect(state.operations[0]?.cursor).toBe(66);
		expect(
			captureProgressSchema.options[0].parse(
				JSON.parse(state.operations[0]?.progressJson ?? 'null')
			).pageDigests
		).toHaveLength(2);
		await seal(f, operation.operationId);
		state = await counts(f);
		expect(state.operations[0]).toMatchObject({
			phase: 'publishing',
			candidateDigest: identity.digest,
			cursor: 0
		});
		await seal(f, operation.operationId);
		state = await counts(f);
		expect(state.operations[0]?.cursor).toBe(64);
		await restartTestServers();
		const response = await finish(f, operation.operationId);
		expect(response.publication.digest).toBe(identity.digest);
		const portable = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) =>
				instance.context.db
					.select()
					.from(schema.publicationManifestMembers)
					.where(eq(schema.publicationManifestMembers.digest, identity.digest))
					.orderBy(schema.publicationManifestMembers.ordinal)
					.all()
		);
		expect(
			portable.map(({ storePath, narHash }) => ({ storePath, narHash }))
		).toStrictEqual(identity.members);
	});
	it('isolates competing operation candidates, selects the first complete set and never merges losing members', async () => {
		const f = await fixture();
		const members = await localMembers(f, 1);
		const first = await staging(f);
		const other = await begin(f, {
			...f.request,
			requestId: publicationRequestIdSchema.parse(crypto.randomUUID()),
			origin: 'legacy-selection',
			memberCount: 2
		});
		if (other.kind !== 'staging') {
			throw new Error('Expected competing candidate');
		}
		await localPage(f, {
			operationId: first.operationId,
			page: 0,
			members: [f.request.result]
		});
		await localPage(f, { operationId: other.operationId, page: 0, members });
		const winner = await finish(f, first.operationId);
		const loser = await finish(f, other.operationId);
		expect(winner.association).toBe('created');
		expect(loser).toStrictEqual({ ...winner, association: 'existing' });
		const selected = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const cache = instance.context.cacheRepository.require(f.scope);
				return new PublicationManifestRepository(
					instance.context
				).selectedMembers(cache, f.result);
			}
		);
		expect(selected?.materialisationId).toBe(first.operationId);
		expect(selected?.members).toHaveLength(1);
	});
	it('rejects a full declared set that omits its exact result', async () => {
		const f = await fixture();
		const members = await localMembers(f, 1);
		const operation = await staging(f);
		await localPage(f, {
			operationId: operation.operationId,
			page: 0,
			members: members.slice(1)
		});
		await expect(seal(f, operation.operationId)).rejects.toMatchObject({
			code: 'PUBLICATION_INVALID_PAGE'
		});
	});
	it('freezes intake and keeps identical page replay immutable after sealing starts', async () => {
		const f = await fixture();
		const operation = await staging(f);
		const request = {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		};
		await page(f, request);
		await seal(f, operation.operationId);
		await expect(page(f, { ...request, page: 1 })).rejects.toMatchObject({
			code: 'PUBLICATION_INVALID_PAGE'
		});
		expect(await page(f, request)).toMatchObject({ acceptedCount: 1 });
		expect(await finish(f, operation.operationId)).toMatchObject({
			kind: 'captured'
		});
	});
	it('fails a previously hashed proof changed by SQL REPLACE and never returns a captured receipt', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		await seal(f, operation.operationId);
		await seal(f, operation.operationId);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.scope);
			const row = instance.context.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.cacheId, cache.id))
				.get();
			if (row === undefined) {
				throw new Error('Missing proof');
			}
			instance.context.db.run(
				sql`INSERT OR REPLACE INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, deriver, ca, sigs_json, created_at, generation) SELECT cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, deriver, ca, sigs_json, created_at, generation + 1 FROM narinfo WHERE cache_id = ${cache.id}`
			);
		});
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			withRowBudget(() =>
				new PublicationManifestAvailabilityStore(instance.context.db).drain()
			);
		});
		const state = await counts(f);
		expect(state.operations[0]?.state).toBe('failed');
		await expect(seal(f, operation.operationId)).rejects.toMatchObject({
			code: 'CONFLICT'
		});
		expect(state.associations).toHaveLength(0);
	});
	it('detects missing staged proof instead of success at finalisation', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		for (let step = 0; step < 4; step += 1) {
			await seal(f, operation.operationId);
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.delete(schema.resultPublicationMembers)
				.where(
					eq(
						schema.resultPublicationMembers.materialisationId,
						operation.operationId
					)
				)
				.run()
		);
		await expect(seal(f, operation.operationId)).rejects.toMatchObject({
			code: 'CONFLICT'
		});
		const state = await counts(f);
		expect(state.associations).toHaveLength(0);
	});
	it('preserves a completed seal receipt through identical begin replay and reset', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		const receipt = await finish(f, operation.operationId);
		const before = await counts(f);
		const replay = await begin(f);
		await restartTestServers();
		const status = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			new PublicationManifestCaptureService(instance.context).captureStatus(
				f.scope,
				f.grants,
				{ operationId: operation.operationId }
			)
		);
		expect({
			receipt,
			replay,
			seal: await seal(f, operation.operationId),
			status,
			storage: await counts(f)
		}).toStrictEqual({
			receipt: { ...receipt, association: 'created' },
			replay: { kind: 'existing', publication: receipt.publication },
			seal: receipt,
			status: receipt,
			storage: before
		});
	});
	for (const association of ['created', 'existing'] as const) {
		it.each(['begin', 'seal', 'status'] as const)(
			`replays the original ${association} metadata receipt through %s after non-result member deletion`,
			async (replayPath) => {
				await withoutAlarmArming(async () => {
					const f = await fixture();
					const child = await committedPath('capture-replay-child', f.scope, {
						storePathHash: '33333333333333333333333333333333',
						name: 'child'
					});
					const token = await initialiseViaWorker();
					const rooted = await authorisedWorkerFetch(
						cacheScopedPath(f.scope, '/roots/capture-replay'),
						token,
						{
							method: 'PUT',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ targets: [f.result.storePath] })
						}
					);
					expect(rooted.status).toBe(200);
					f.request = { ...f.request, memberCount: 2 };
					const operation = await staging(f);
					const members = await runInDurableObject(
						fixtureWorkerServer(),
						(instance) => {
							const cache = instance.context.cacheRepository.require(f.scope);
							return instance.context.db
								.select({
									storePath: schema.narInfos.storePath,
									narHash: schema.narInfos.narHash,
									generation: schema.narInfos.generation
								})
								.from(schema.narInfos)
								.where(eq(schema.narInfos.cacheId, cache.id))
								.all();
						}
					);
					await page(f, {
						operationId: operation.operationId,
						page: 0,
						members
					});
					const captured = await finish(f, operation.operationId);
					let operationId = operation.operationId;
					if (association === 'existing') {
						f.request = {
							...f.request,
							requestId: createPublicationRequestId(),
							origin: 'legacy-selection',
							memberCount: 1
						};
						expect(await begin(f)).toStrictEqual({
							kind: 'existing',
							publication: captured.publication
						});
						const state = await counts(f);
						operationId = publicationOperationIdSchema.parse(
							state.operations.find(
								(row) => row.requestId === f.request.requestId
							)?.id
						);
					}
					const receipt = await seal(f, operationId);
					const identity = await publicationManifestIdentity(
						members.map(({ storePath, narHash }) => ({ storePath, narHash }))
					);
					expect(receipt).toStrictEqual({
						kind: 'captured',
						association,
						publication: {
							result: f.result,
							digest: identity.digest,
							memberCount: 2,
							origin: 'build-selection'
						}
					});
					expect(receipt).not.toHaveProperty('publication.materialisation');
					const replay = () =>
						replayPath === 'begin'
							? begin(f)
							: replayPath === 'seal'
								? seal(f, operationId)
								: runInDurableObject(fixtureWorkerServer(), (instance) =>
										new PublicationManifestCaptureService(
											instance.context
										).captureStatus(f.scope, f.grants, { operationId })
									);
					const removed = await authorisedWorkerFetch(
						cacheScopedPath(f.scope, `/paths/${child.storePathHash}`),
						token,
						{ method: 'DELETE' }
					);
					expect(removed.status).toBe(200);
					expect(await removed.json()).toMatchObject({ deleted: true });
					await expect(replay()).rejects.toMatchObject({
						code: 'SERVICE_UNAVAILABLE'
					});
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						const availability = new PublicationManifestAvailabilityStore(
							instance.context.db
						);
						expect(availability.nextIntent(false)).toBeDefined();
						expect(withRowBudget(() => availability.drain())).toBe(false);
						expect(availability.nextIntent(false)).toBeUndefined();
						const cache = instance.context.cacheRepository.require(f.scope);
						expect(
							new PublicationManifestRepository(instance.context).association(
								cache,
								f.result
							)
						).toStrictEqual({
							publication: captured.publication,
							complete: false
						});
						expect(
							new PublicationManifestAuthority(
								instance.context
							).resolveRecorded(f.scope, f.grants, captured.publication).result
						).toStrictEqual(f.result);
					});
					const state = () =>
						runInDurableObject(fixtureWorkerServer(), async (instance) => {
							const { db, d1 } = instance.context;
							return {
								operations: db
									.select()
									.from(schema.publicationManifestOperations)
									.all(),
								pages: db
									.select()
									.from(schema.publicationManifestOperationPages)
									.all(),
								associations: db.select().from(schema.resultPublications).all(),
								proofs: db.select().from(schema.resultPublicationMembers).all(),
								manifests: db.select().from(schema.publicationManifests).all(),
								members: db
									.select()
									.from(schema.publicationManifestMembers)
									.all(),
								cardinalities: db
									.select()
									.from(schema.publicationManifestCardinalities)
									.all(),
								paths: db.select().from(schema.narInfos).all(),
								grace: db.select().from(schema.retentionGrace).all(),
								roots: db.select().from(schema.retentionRoots).all(),
								targets: db.select().from(schema.retentionRootTargets).all(),
								receipts: db.select().from(schema.confirmationReceipts).all(),
								edges: await d1.select().from(d1Schema.blobReference).all(),
								usage: await d1.select().from(d1Schema.tenantUsage).all(),
								ownership: await d1.select().from(d1Schema.tenantBlob).all()
							};
						});
					const before = await state();
					expect({
						replay: await replay(),
						state: await state()
					}).toStrictEqual({
						replay:
							replayPath === 'begin'
								? { kind: 'existing', publication: captured.publication }
								: receipt,
						state: before
					});
					expect(
						await begin(f, {
							...f.request,
							requestId: createPublicationRequestId(),
							memberCount: 1
						})
					).toStrictEqual({
						kind: 'existing',
						publication: captured.publication
					});
					await runInDurableObject(fixtureWorkerServer(), async (instance) => {
						expect(
							await new PublicationManifestRepository(instance.context).lookup(
								f.scope,
								f.grants,
								{
									source: {
										cache: f.scope,
										expectedCacheGeneration: f.result.cacheGeneration
									},
									results: [f.request.result]
								}
							)
						).toStrictEqual({
							entries: [
								{
									kind: 'recorded',
									publication: captured.publication,
									complete: false
								}
							]
						});
					});
					const ensured = await authorisedWorkerFetch(
						cacheScopedPath(f.scope, '/publication-results/ensure'),
						token,
						{
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								requestId: createPublicationRequestId(),
								source: captured.publication,
								expectedDestinationGeneration: f.result.cacheGeneration
							})
						}
					);
					expect(ensured.status).toBe(409);
					expect(await ensured.json()).toMatchObject({
						code: 'PUBLICATION_RESULT_CHANGED'
					});
					const afterEnsure = await state();
					expect(afterEnsure.associations).toStrictEqual(before.associations);
				}, fixtureWorkerServer());
			}
		);
	}
	it('arbitrates concurrent finalisation and refuses a completed receipt whose association disappeared', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		for (let step = 0; step < 4; step += 1) {
			await seal(f, operation.operationId);
		}
		const responses = await Promise.all([
			seal(f, operation.operationId),
			seal(f, operation.operationId)
		]);
		expect(responses[0]).toStrictEqual(responses[1]);
		expect(responses[0]).toMatchObject({
			kind: 'captured',
			association: 'created'
		});
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.scope);
			instance.context.db
				.delete(schema.resultPublications)
				.where(eq(schema.resultPublications.cacheId, cache.id))
				.run();
		});
		await expect(seal(f, operation.operationId)).rejects.toMatchObject({
			code: 'PUBLICATION_RESULT_CHANGED'
		});
	});
});

describe('PublicationManifestCaptureService continuation races', () => {
	beforeEach(resetTestServer);
	it('rejects malformed discriminated progress instead of continuing from unchecked JSON', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		await seal(f, operation.operationId);
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.update(schema.publicationManifestOperations)
				.set({
					progressJson: JSON.stringify({
						phase: 'sealing',
						lastPath: '',
						pageDigests: ['not-a-digest']
					})
				})
				.where(
					eq(schema.publicationManifestOperations.id, operation.operationId)
				)
				.run()
		);
		await expect(seal(f, operation.operationId)).rejects.toThrow();
		const state = await counts(f);
		expect(state.associations).toHaveLength(0);
	});
	it('invalidates a member changed between leaf hashing and the short progress gate', async () => {
		const f = await fixture();
		const members = await localMembers(f, 1);
		f.request = { ...f.request, memberCount: 2 };
		const operation = await staging(f);
		await localPage(f, {
			operationId: operation.operationId,
			page: 0,
			members
		});
		await seal(f, operation.operationId);
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const original = crypto.subtle.digest.bind(crypto.subtle);
			const hashing = vi
				.spyOn(crypto.subtle, 'digest')
				.mockImplementation(async (algorithm, bytes) => {
					const digest = await original(algorithm, bytes);
					const member = members[1];
					if (member === undefined) {
						throw new Error('Missing member');
					}
					const cache = instance.context.cacheRepository.require(f.scope);
					instance.context.db
						.update(schema.narInfos)
						.set({
							generation: narInfoGenerationSchema.parse(member.generation + 1)
						})
						.where(
							eq(
								schema.narInfos.storePathHash,
								StorePath.hash(member.storePath)
							)
						)
						.run();
					expect(cache.id).toBeGreaterThan(0);
					return digest;
				});
			try {
				await expect(
					new PublicationManifestCaptureService(instance.context).captureSeal(
						f.scope,
						f.grants,
						{ operationId: operation.operationId }
					)
				).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
				withRowBudget(() =>
					new PublicationManifestAvailabilityStore(instance.context.db).drain()
				);
			} finally {
				hashing.mockRestore();
			}
		});
		const state = await counts(f);
		expect(state.operations[0]).toMatchObject({ state: 'failed', cursor: 0 });
		expect(state.associations).toHaveLength(0);
	});
	it('rolls back winner selection and its receipt together on finalisation failure', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		for (let step = 0; step < 4; step += 1) {
			await seal(f, operation.operationId);
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db.run(
				sql`CREATE TRIGGER capture_final_abort BEFORE UPDATE OF state ON publication_manifest_operation WHEN NEW.state = 'complete' BEGIN SELECT RAISE(ABORT,'final rollback'); END`
			)
		);
		await expect(seal(f, operation.operationId)).rejects.toThrow();
		let state = await counts(f);
		expect(state.associations).toHaveLength(0);
		expect(state.operations[0]?.state).toBe('pending');
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db.run(sql`DROP TRIGGER capture_final_abort`)
		);
		expect(await seal(f, operation.operationId)).toMatchObject({
			kind: 'captured',
			association: 'created'
		});
		state = await counts(f);
		expect(state.associations).toHaveLength(1);
	});
	it('keeps the immutable original deadline throughout seal continuation', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture();
			const operation = await staging(f);
			await page(f, {
				operationId: operation.operationId,
				page: 0,
				members: [f.request.result]
			});
			await seal(f, operation.operationId);
			expect(
				await page(f, {
					operationId: operation.operationId,
					page: 0,
					members: [f.request.result]
				})
			).toMatchObject({ acceptedCount: 1 });
			const state = await counts(f);
			expect(state.operations[0]?.expiresAt).toBe(operation.expiresAt);
			await runInDurableObject(fixtureWorkerServer(), (instance) =>
				instance.context.db
					.update(schema.publicationManifestOperations)
					.set({ expiresAt: isoTimestamp(new Date(0)) })
					.where(
						eq(schema.publicationManifestOperations.id, operation.operationId)
					)
					.run()
			);
			await expect(seal(f, operation.operationId)).rejects.toMatchObject({
				code: 'GONE'
			});
		}, fixtureWorkerServer());
	});
});

describe('PublicationManifestCaptureService portable publication', () => {
	beforeEach(resetTestServer);
	it('shares only identical canonical content and arbitrates competing final gates without merging candidates', async () => {
		const f = await fixture();
		const first = await staging(f);
		const second = await begin(f, {
			...f.request,
			origin: 'legacy-selection',
			requestId: publicationRequestIdSchema.parse(crypto.randomUUID())
		});
		if (second.kind !== 'staging') {
			throw new Error('Expected second candidate');
		}
		await page(f, {
			operationId: first.operationId,
			page: 0,
			members: [f.request.result]
		});
		await page(f, {
			operationId: second.operationId,
			page: 0,
			members: [f.request.result]
		});
		for (let step = 0; step < 4; step += 1) {
			await Promise.all([
				seal(f, first.operationId),
				seal(f, second.operationId)
			]);
		}
		const outcomes = await Promise.all([
			seal(f, first.operationId),
			seal(f, second.operationId)
		]);
		const captured = outcomes.filter((outcome) => outcome.kind === 'captured');
		expect(
			captured.map((outcome) => outcome.association).toSorted(byCodeUnit)
		).toStrictEqual(['created', 'existing']);
		expect(captured[0]?.publication).toStrictEqual(captured[1]?.publication);
		const state = await counts(f);
		expect(state.associations).toHaveLength(1);
		expect(state.operations.map((operation) => operation.state)).toStrictEqual([
			'complete',
			'complete'
		]);
	});
	it('rejects incompatible existing portable slots rather than ignoring them and finalising', async () => {
		const f = await fixture();
		const operation = await staging(f);
		await page(f, {
			operationId: operation.operationId,
			page: 0,
			members: [f.request.result]
		});
		for (let step = 0; step < 3; step += 1) {
			await seal(f, operation.operationId);
		}
		const state = await counts(f);
		const digest = state.operations[0]?.candidateDigest;
		if (digest === null || digest === undefined) {
			throw new Error('Missing candidate digest');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.insert(schema.publicationManifestMembers)
				.values({
					digest,
					ordinal: 0,
					storePath: storePathSchema.parse(
						'/nix/store/00000000000000000000000000000000-incompatible'
					),
					storePathHash: storePathHashSchema.parse(
						'00000000000000000000000000000000'
					),
					narHash: f.result.narHash
				})
				.run()
		);
		await expect(seal(f, operation.operationId)).rejects.toThrow('immutable');
		const after = await counts(f);
		expect(after.associations).toHaveLength(0);
		expect(after.operations[0]).toMatchObject({
			state: 'pending',
			phase: 'publishing',
			cursor: 0
		});
	});
});

describe('PublicationManifestCaptureService bounded finalisation cost', () => {
	beforeEach(resetTestServer);
	it.each([
		'intake',
		'sealing',
		'publishing',
		'sealing-page',
		'publishing-page'
	] as const)(
		'bounds the %s boundary independently of 100000 staged members',
		async (step) => {
			const phase =
				step === 'sealing-page'
					? 'sealing'
					: step === 'publishing-page'
						? 'publishing'
						: step;
			const isPageStep = step.endsWith('-page');
			const costs = [];
			for (const memberCount of [64, 100_000]) {
				const f = await fixture();
				f.request = { ...f.request, memberCount };
				const operation = await staging(f);
				const identity = await publicationManifestIdentity([
					{ storePath: f.result.storePath, narHash: f.result.narHash }
				]);
				const leaf = await publicationManifestLeafIdentity(identity.members);
				// Seed prior pages outside the measured invocation; each call below
				// advances only one real boundary or 64-member page.
				const pageDigests = Array.from(
					{ length: Math.ceil(memberCount / 64) },
					() => leaf.digest
				);
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					const cache = instance.context.cacheRepository.require(f.scope);
					instance.context.db.run(sql`
						WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ${memberCount})
						INSERT INTO result_publication_member (cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation)
						SELECT ${cache.id},${cache.generation},${StorePath.hash(f.result.storePath)},${f.result.generation},${operation.operationId},
						CASE WHEN n=1 THEN ${StorePath.hash(f.result.storePath)} ELSE printf('%032d',n) END,
						CASE WHEN n=1 THEN ${f.result.storePath} ELSE printf('/nix/store/%032d-app',n) END,
						${f.result.narHash},${f.result.generation} FROM sequence`);
					if (phase === 'publishing') {
						instance.context.db
							.insert(schema.publicationManifests)
							.values({ digest: identity.digest, version: 1, memberCount })
							.onConflictDoNothing()
							.run();
						if (!isPageStep) {
							instance.context.db.run(sql`
							INSERT INTO publication_manifest_member
							SELECT ${identity.digest}, row_number() OVER (ORDER BY member_path)-1, member_path, member_hash, member_nar_hash
							FROM result_publication_member WHERE materialisation_id=${operation.operationId}`);
						}
					}
					instance.context.db
						.update(schema.publicationManifestOperations)
						.set({
							phase,
							cursor: isPageStep ? 0 : memberCount,
							candidateDigest:
								phase === 'publishing' ? identity.digest : undefined,
							progressJson:
								phase === 'intake'
									? undefined
									: JSON.stringify(
											phase === 'sealing'
												? {
														phase,
														lastPath: '',
														pageDigests: isPageStep ? [] : pageDigests
													}
												: { phase, lastPath: '' }
										)
						})
						.where(
							eq(schema.publicationManifestOperations.id, operation.operationId)
						)
						.run();
				});
				costs.push(
					await runInDurableObject(fixtureWorkerServer(), (instance) =>
						withRowBudget(async () => {
							const response = await new PublicationManifestCaptureService(
								instance.context
							).captureSeal(f.scope, f.grants, {
								operationId: operation.operationId
							});
							const meter = currentRowBudgetMeter();
							if (meter === undefined) {
								throw new Error('Missing cost meter');
							}
							meter.recordOutstanding();
							return {
								kind: response.kind,
								rowsRead: meter.rowsRead,
								rowsWritten: meter.rowsWritten
							};
						})
					)
				);
			}
			for (const cost of costs) {
				expect(cost.rowsRead).toBeLessThan(isPageStep ? 5000 : 1000);
				expect(cost.rowsWritten).toBeLessThan(isPageStep ? 1000 : 100);
			}
			expect(costs[1]).toEqual(costs[0]);
			const expectedCosts = {
				intake: { kind: 'pending', rowsRead: 28, rowsWritten: 1 },
				sealing: { kind: 'pending', rowsRead: 29, rowsWritten: 6 },
				publishing: { kind: 'captured', rowsRead: 36, rowsWritten: 6 },
				'sealing-page': { kind: 'pending', rowsRead: 88, rowsWritten: 1 },
				'publishing-page': { kind: 'pending', rowsRead: 216, rowsWritten: 257 }
			};
			expect(costs).toStrictEqual([expectedCosts[step], expectedCosts[step]]);
		}
	);
});

describe('PublicationManifestCaptureService bounded intake cost', () => {
	beforeEach(resetTestServer);
	it('stages 64 proofs at constant cost with 64 or 99936 prior members', async () => {
		const costs = [];
		for (const memberCount of [128, 100_000]) {
			const f = await fixture();
			const members = await localMembers(f, 63);
			f.request = { ...f.request, memberCount };
			const operation = await staging(f);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(f.scope);
				if (memberCount > 64) {
					instance.context.db.run(sql`
						WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ${memberCount - 64})
						INSERT INTO result_publication_member (cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation)
						SELECT ${cache.id},${cache.generation},${StorePath.hash(f.result.storePath)},${f.result.generation},${operation.operationId},
						printf('%032d',n),printf('/nix/store/%032d-app',n),${f.result.narHash},${f.result.generation} FROM sequence`);
				}
				instance.context.db
					.update(schema.publicationManifestOperations)
					.set({ cursor: memberCount - 64, nextPage: 1 })
					.where(
						eq(schema.publicationManifestOperations.id, operation.operationId)
					)
					.run();
			});
			costs.push(
				await runInDurableObject(fixtureWorkerServer(), (instance) =>
					withRowBudget(async () => {
						const probe = vi
							.spyOn(PublicationManifestAuthority.prototype, 'requireServable')
							.mockResolvedValue();
						try {
							const response = await new PublicationManifestCaptureService(
								instance.context
							).capturePage(f.scope, f.grants, {
								operationId: operation.operationId,
								page: 1,
								members
							});
							const meter = currentRowBudgetMeter();
							if (meter === undefined) {
								throw new Error('Missing cost meter');
							}
							meter.recordOutstanding();
							return {
								acceptedCount: response.acceptedCount,
								rowsRead: meter.rowsRead,
								rowsWritten: meter.rowsWritten
							};
						} finally {
							probe.mockRestore();
						}
					})
				)
			);
		}
		for (const cost of costs) {
			expect(cost.acceptedCount).toBe(64);
			expect(cost.rowsRead).toBeLessThan(5000);
			expect(cost.rowsWritten).toBeLessThan(1000);
		}
		expect(costs[1]).toEqual(costs[0]);
		expect(costs[0]).toStrictEqual({
			acceptedCount: 64,
			rowsRead: 792,
			rowsWritten: 323
		});
	});
});
