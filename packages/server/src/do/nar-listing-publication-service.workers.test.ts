import {
	cacheGenerationSchema,
	type CacheScope,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	artifactGenerationSchema,
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, lte, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import { type NarListingAdoptionRequest } from '../blob/nar-listing-adoption.ts';
import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { ListingAdoptionConsumerStore } from '../db/listing-adoption-consumer.ts';
import { ListingFactStore } from '../db/listing-facts.ts';
import * as schema from '../db/schema.ts';
import { ListingFactConflictError } from '../errors.ts';
import { casObjectKey } from '../http/http.ts';
import { type ListingAdoptionQueueMessage } from '../routing/listing-adoption-queue-message.ts';
import { type ListingAdoptionWorkMessage } from '../routing/listing-adoption-work-message.ts';
import { ListingAdoptionWorkQueue } from '../routing/listing-adoption-work-queue.ts';
import { handleWorkerQueue } from '../routing/queue.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitUpload,
	currentServer,
	defaultCache,
	initialise,
	namedCache,
	negotiateUploads,
	putNarBytes,
	putTestCache,
	recordTransition,
	resetTestServer,
	singleDecision,
	testControlEnv,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { ArtifactCasService } from './artifact-cas-service.ts';
import {
	type ArtifactPublicationParent,
	ArtifactRetentionService
} from './artifact-retention-service.ts';
import { ArtifactRetirementService } from './artifact-retirement-service.ts';
import { type ServerContext } from './context.ts';
import { NarListingPublicationService } from './nar-listing-publication-service.ts';
import { NarListingReadService } from './nar-listing-read-service.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import {
	subrequestsAvailable,
	withSubrequestSlice
} from './subrequest-slice.ts';

const bytes = new TextEncoder().encode(
	JSON.stringify({ version: 1, root: { type: 'directory', entries: {} } })
);

async function publishParent(
	token: string,
	character = 'a',
	scope: CacheScope = defaultCache()
): Promise<ArtifactPublicationParent> {
	const nar = await verifiableNar('listing-publication');
	const storePathHash = storePathHashSchema.parse(character.repeat(32));
	const metadata = uploadMetadata({
		storePathHash,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	const upload = singleDecision(
		await negotiateUploads(token, [metadata], scope)
	);
	if (upload.action !== 'upload' && upload.action !== 'commit') {
		throw new Error('Expected a publication decision for the fixture parent');
	}
	if (upload.action === 'upload') {
		await putNarBytes(upload.r2Key, nar);
	}
	await commitUpload(token, upload.uploadId, scope);
	return runInDurableObject(currentServer(), (instance) => {
		const context = instance.context;
		const cache = context.cacheRepository.require(scope);
		const row = context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();
		if (row === undefined) {
			throw new Error('The fixture parent was not published');
		}
		return { cache, storePathHash, generation: row.generation };
	});
}

async function recordFact(context: ServerContext) {
	const nar = await verifiableNar('listing-publication');
	const fact: NarListingFact = {
		narHash: nar.narHash,
		generatorRevision: currentListingGeneratorRevision,
		format: 1,
		digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
		size: bytes.byteLength
	};
	const incarnation = await new CasObjectStore(
		context.d1,
		context.env.BLOBS
	).promote({
		...fact,
		bytes
	});
	await new ListingFactStore(context.d1).record(fact);
	return { fact, incarnation };
}

async function publicationState(context: ServerContext) {
	const usage = await context.d1
		.select({
			bytes: d1Schema.tenantUsage.casBytes,
			blobs: d1Schema.tenantUsage.casBlobs
		})
		.from(d1Schema.tenantUsage)
		.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
		.get();
	return {
		artifacts: context.db.select().from(schema.artifacts).all(),
		listings: context.db.select().from(schema.narListings).all(),
		parents: context.db.select().from(schema.artifactParents).all(),
		roots: context.db.select().from(schema.artifactRoots).all(),
		deletions: context.db.select().from(schema.artifactReferenceDeletion).all(),
		references: await context.d1
			.select()
			.from(d1Schema.artifactReference)
			.all(),
		usage
	};
}

function adoptionRequest(
	fact: NarListingFact,
	parent: ArtifactPublicationParent
): NarListingAdoptionRequest {
	return {
		identity: {
			narHash: fact.narHash,
			generatorRevision: fact.generatorRevision
		},
		cache: parent.cache.scope,
		cacheGeneration: parent.cache.generation,
		storePathHash: parent.storePathHash,
		generation: parent.generation
	};
}

async function adoptOne(request: NarListingAdoptionRequest) {
	const [result] = await currentServer().adoptNarListings([request]);
	if (result === undefined) {
		throw new Error('The adoption RPC omitted its result');
	}
	return result;
}

describe('listing publication by reference', () => {
	let token: string;
	beforeEach(async () => {
		await resetTestServer();
		token = await withoutAlarmArming(initialise);
		await recordTransition('native-artifact-storage', 'expanded');
		await recordTransition('native-artifact-publication', 'complete');
	});

	it('reuses one listing and quota charge for two parents without opening source bytes', () =>
		withoutAlarmArming(async () => {
			const first = await publishParent(token);
			const second = await publishParent(token, 'b');
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const { fact } = await recordFact(context);
				const get = vi.spyOn(context.env.BLOBS, 'get');
				const put = vi.spyOn(context.env.BLOBS, 'put');
				await context.criticalSection(async () => {
					const publisher = new NarListingPublicationService(context);
					const result = await publisher.reuseInSection(fact, first);
					if (result.kind !== 'published') {
						throw new Error('Expected a published listing');
					}
					const before = await publicationState(context);
					expect({
						repeated: await publisher.reuseInSection(fact, first),
						state: await publicationState(context)
					}).toStrictEqual({
						repeated: { kind: 'already-present', artifact: result.artifact },
						state: before
					});
					expect(await publisher.reuseInSection(fact, second)).toStrictEqual({
						kind: 'published',
						artifact: result.artifact
					});
					const after = await publicationState(context);
					expect(after).toStrictEqual({
						...before,
						parents: [
							...before.parents,
							{
								artifactId: result.artifact.id,
								artifactGeneration: result.artifact.generation,
								cacheId: second.cache.id,
								storePathHash: second.storePathHash,
								publicationGeneration: second.generation
							}
						]
					});
					expect({ gets: get.mock.calls, puts: put.mock.calls }).toStrictEqual({
						gets: [],
						puts: []
					});
					get.mockRestore();
					put.mockRestore();
					const response = await new NarListingReadService(context).serve(
						new Request('https://cache.example/listing'),
						first.cache.scope,
						first.storePathHash
					);
					expect({
						status: response.status,
						body: await response.text(),
						etag: response.headers.get('etag'),
						usage: after.usage,
						roots: after.roots
					}).toStrictEqual({
						status: 200,
						body: new TextDecoder().decode(bytes),
						etag: `"${fact.digest}"`,
						usage: { bytes: fact.size, blobs: 1 },
						roots: []
					});
				});
			});
		}));

	it('creates cache-scoped logical references while sharing physical bytes and tenant quota', () =>
		withoutAlarmArming(async () => {
			const scope = namedCache('release');
			await putTestCache(token, scope);
			const first = await publishParent(token);
			const second = await publishParent(token, 'b', scope);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const { fact, incarnation } = await recordFact(context);
				await context.criticalSection(async () => {
					const publisher = new NarListingPublicationService(context);
					for (const parent of [first, second]) {
						const result = await publisher.reuseInSection(fact, parent);
						expect(result.kind).toBe('published');
					}
					const state = await publicationState(context);
					expect({
						artifacts: state.artifacts.map((row) => ({
							cacheId: row.cacheId,
							digest: row.digest,
							incarnation: row.publicationIncarnation,
							state: row.state
						})),
						references: state.references.map((row) => ({
							digest: row.digest,
							cacheKind: row.cacheKind,
							cacheName: row.cacheName ?? undefined
						})),
						usage: state.usage
					}).toStrictEqual({
						artifacts: [first, second].map((parent) => ({
							cacheId: parent.cache.id,
							digest: fact.digest,
							incarnation,
							state: 'live'
						})),
						references: [
							{
								digest: fact.digest,
								cacheKind: 'default',
								cacheName: undefined
							},
							{ digest: fact.digest, cacheKind: 'named', cacheName: scope.name }
						],
						usage: { bytes: fact.size, blobs: 1 }
					});
				});
			});
		}));

	it.each([
		'missing-fact',
		'missing-object',
		'old-parent',
		'old-cache',
		'changed-nar',
		'revoked-parent'
	] as const)(
		'refuses %s without a readable publication or quota charge',
		(reason) =>
			withoutAlarmArming(async () => {
				const parent = await publishParent(token);
				await runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					const { fact, incarnation } = await recordFact(context);
					let captured = parent;
					switch (reason) {
						case 'missing-fact': {
							await context.d1.delete(d1Schema.listingFact);
							break;
						}
						case 'missing-object': {
							await context.env.BLOBS.delete(
								casObjectKey(fact.digest, incarnation)
							);
							break;
						}
						case 'old-parent': {
							captured = {
								...parent,
								generation: narInfoGenerationSchema.parse(parent.generation + 1)
							};
							break;
						}
						case 'old-cache': {
							captured = {
								...parent,
								cache: {
									...parent.cache,
									generation: cacheGenerationSchema.parse(
										parent.cache.generation + 1
									)
								}
							};
							break;
						}
						case 'changed-nar': {
							const other = await verifiableNar('another-parent');
							context.db
								.update(schema.narInfos)
								.set({ narHash: other.narHash })
								.run();
							break;
						}
						case 'revoked-parent': {
							await new PathReadAuthorityService(context).revoke(parent.cache, [
								{
									storePathHash: parent.storePathHash,
									generation: parent.generation
								}
							]);
							break;
						}
					}
					await context.criticalSection(async () => {
						const result = await new NarListingPublicationService(
							context
						).reuseInSection(fact, captured);
						expect(result).toStrictEqual({
							kind:
								reason === 'missing-fact'
									? 'fact-missing'
									: reason === 'missing-object'
										? 'bytes-missing'
										: 'unavailable'
						});
						await new ArtifactRetirementService(context).drainInSection();
						expect(await publicationState(context)).toStrictEqual({
							artifacts: [],
							listings: [],
							parents: [],
							roots: [],
							deletions: [],
							references: [],
							usage: { bytes: 0, blobs: 0 }
						});
					});
				});
			})
	);

	it('retires a pending reservation after a lost response and releases its quota through the outbox', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const { fact } = await recordFact(context);
				const reservation = new ArtifactCasService(context);
				const reserve = reservation.reserveInSection.bind(reservation);
				vi.spyOn(
					ArtifactCasService.prototype,
					'reserveInSection'
				).mockImplementationOnce(async (id, generation) => {
					await reserve(id, generation);
					throw new Error('lost reservation response');
				});
				await context.criticalSection(async () => {
					await expect(
						new NarListingPublicationService(context).reuseInSection(
							fact,
							parent
						)
					).rejects.toThrow('lost reservation response');
					const before = await publicationState(context);
					expect({
						artifacts: before.artifacts.map((row) => row.state),
						deletions: before.deletions.map((row) => row.artifactId),
						parents: before.parents,
						usage: before.usage
					}).toStrictEqual({
						artifacts: ['retired'],
						deletions: before.artifacts.map((row) => row.id),
						parents: [],
						usage: { bytes: fact.size, blobs: 1 }
					});
					await new ArtifactRetirementService(context).drainInSection();
					expect(await publicationState(context)).toStrictEqual({
						artifacts: [],
						listings: [],
						parents: [],
						roots: [],
						deletions: [],
						references: [],
						usage: { bytes: 0, blobs: 0 }
					});
				});
			});
		}));

	it('republishes a retired listing at a new logical generation before its old outbox is drained', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const { fact } = await recordFact(context);
				await context.criticalSection(async () => {
					const usage = await context.d1
						.select({ bytes: d1Schema.tenantUsage.bytes })
						.from(d1Schema.tenantUsage)
						.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
						.get();
					if (usage === undefined) {
						throw new Error('The fixture tenant has no usage record');
					}
					await context.d1
						.update(d1Schema.tenantUsage)
						.set({ quotaBytes: usage.bytes + fact.size - 1 })
						.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant));
					const publisher = new NarListingPublicationService(context);
					expect(await publisher.reuseInSection(fact, parent)).toStrictEqual({
						kind: 'over-quota'
					});
					const retired = context.db.select().from(schema.artifacts).get();
					if (retired === undefined) {
						throw new Error('Expected a retired publication attempt');
					}
					await context.d1
						.update(d1Schema.tenantUsage)
						.set({ quotaBytes: sql`null` })
						.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant));
					const result = await publisher.reuseInSection(fact, parent);
					expect(result).toStrictEqual({
						kind: 'published',
						artifact: {
							id: retired.id,
							generation: artifactGenerationSchema.parse(retired.generation + 1)
						}
					});
					const before = await publicationState(context);
					await new ArtifactRetirementService(context).drainInSection();
					expect(await publicationState(context)).toStrictEqual({
						...before,
						deletions: []
					});
				});
			});
		}));

	it('refuses a conflicting cache-local digest without replacing the publication', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const { fact } = await recordFact(context);
				await context.criticalSection(async () => {
					const publisher = new NarListingPublicationService(context);
					await publisher.reuseInSection(fact, parent);
					context.db
						.update(schema.artifacts)
						.set({ digest: sha256HexDigestSchema.parse('f'.repeat(64)) })
						.run();
					const before = await publicationState(context);
					await expect(
						publisher.reuseInSection(fact, parent)
					).rejects.toBeInstanceOf(ListingFactConflictError);
					expect(await publicationState(context)).toStrictEqual(before);
				});
			});
		}));

	it('reuses the logical publication after missing CAS bytes are repaired at a new incarnation', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const { fact, incarnation } = await recordFact(context);
				await context.criticalSection(async () => {
					const publisher = new NarListingPublicationService(context);
					const first = await publisher.reuseInSection(fact, parent);
					const before = await publicationState(context);
					await context.env.BLOBS.delete(
						casObjectKey(fact.digest, incarnation)
					);
					expect(await publisher.reuseInSection(fact, parent)).toStrictEqual({
						kind: 'bytes-missing'
					});
					const repaired = await new CasObjectStore(
						context.d1,
						context.env.BLOBS
					).promote({ ...fact, bytes }, { restoreMissingObject: true });
					expect({
						incarnation: repaired,
						result: await publisher.reuseInSection(fact, parent),
						state: await publicationState(context)
					}).toStrictEqual({
						incarnation: incarnation + 1,
						result: first,
						state: {
							...before,
							artifacts: before.artifacts.map((row) => ({
								...row,
								publicationIncarnation: repaired
							}))
						}
					});
				});
			});
		}));

	it.each(['reservation', 'attachment'] as const)(
		'refuses a producer revoked during %s and retires only its pending publication',
		(step) =>
			withoutAlarmArming(async () => {
				const parent = await publishParent(token);
				await runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					const { fact } = await recordFact(context);
					let isCurrent = true;
					switch (step) {
						case 'reservation': {
							const service = new ArtifactCasService(context);
							const reserve = service.reserveInSection.bind(service);
							vi.spyOn(
								ArtifactCasService.prototype,
								'reserveInSection'
							).mockImplementationOnce(async (id, generation) => {
								const result = await reserve(id, generation);
								isCurrent = false;
								return result;
							});
							break;
						}
						case 'attachment': {
							const service = new ArtifactRetentionService(context);
							const attach = service.attachParentInSection.bind(service);
							vi.spyOn(
								ArtifactRetentionService.prototype,
								'attachParentInSection'
							).mockImplementationOnce(async (version, publication) => {
								const result = await attach(version, publication);
								isCurrent = false;
								return result;
							});
							break;
						}
					}
					await context.criticalSection(async () => {
						expect(
							await new NarListingPublicationService(context).reuseInSection(
								fact,
								parent,
								() => isCurrent
							)
						).toStrictEqual({ kind: 'unavailable' });
						await new ArtifactRetirementService(context).drainInSection();
						expect(await publicationState(context)).toStrictEqual({
							artifacts: [],
							listings: [],
							parents: [],
							roots: [],
							deletions: [],
							references: [],
							usage: { bytes: 0, blobs: 0 }
						});
					});
				});
			})
	);
	it.each([
		{ label: 'default', scope: defaultCache() },
		{ label: 'private named', scope: namedCache('adopt') }
	])(
		'adoption RPC reuses bytes and quota for two current parents in the $label cache',
		({ scope }) =>
			withoutAlarmArming(async () => {
				if (scope.kind === 'named') {
					await putTestCache(token, scope, 'private');
				}
				const first = await publishParent(token, 'a', scope);
				const second = await publishParent(token, 'b', scope);
				const io = { get: 0, put: 0, multipart: 0 };
				const restores: (() => void)[] = [];
				const { fact, incarnation } = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const context = instance.context;
						const stored = await recordFact(context);
						const get = vi
							.spyOn(context.env.BLOBS, 'get')
							.mockImplementation(() => {
								io.get += 1;
								throw new Error('Adoption must not read payload bytes');
							});
						const put = vi
							.spyOn(context.env.BLOBS, 'put')
							.mockImplementation(() => {
								io.put += 1;
								throw new Error('Adoption must not write payload bytes');
							});
						const multipart = vi
							.spyOn(context.env.BLOBS, 'createMultipartUpload')
							.mockImplementation(() => {
								io.multipart += 1;
								throw new Error('Adoption must not stage payload bytes');
							});
						restores.push(
							() => {
								get.mockRestore();
							},
							() => {
								put.mockRestore();
							},
							() => {
								multipart.mockRestore();
							}
						);
						return stored;
					}
				);
				try {
					const request = adoptionRequest(fact, first);
					const [result, attached] = await currentServer().adoptNarListings([
						request,
						adoptionRequest(fact, second)
					]);
					if (result?.kind !== 'published') {
						throw new Error(
							`Expected a published RPC result, received ${String(result?.kind)}`
						);
					}
					const repeated = await adoptOne(request);
					const state = await runInDurableObject(currentServer(), (instance) =>
						publicationState(instance.context)
					);
					expect({
						repeated,
						attached,
						io,
						artifacts: state.artifacts.map((row) => ({
							id: row.id,
							generation: row.generation,
							cacheId: row.cacheId,
							digest: row.digest,
							incarnation: row.publicationIncarnation,
							state: row.state
						})),
						parents: state.parents,
						references: state.references.map((row) => ({
							tenant: row.tenant,
							artifactId: row.artifactId,
							artifactGeneration: row.artifactGeneration,
							cacheKind: row.cacheKind,
							cacheName: row.cacheName ?? undefined,
							cacheGeneration: row.cacheGeneration,
							kind: row.kind,
							digest: row.digest
						})),
						usage: state.usage
					}).toStrictEqual({
						repeated: { kind: 'already-present', artifact: result.artifact },
						attached: { kind: 'published', artifact: result.artifact },
						io: { get: 0, put: 0, multipart: 0 },
						artifacts: [
							{
								id: result.artifact.id,
								generation: result.artifact.generation,
								cacheId: first.cache.id,
								digest: fact.digest,
								incarnation,
								state: 'live'
							}
						],
						parents: [first, second].map((parent) => ({
							artifactId: result.artifact.id,
							artifactGeneration: result.artifact.generation,
							cacheId: parent.cache.id,
							storePathHash: parent.storePathHash,
							publicationGeneration: parent.generation
						})),
						references: [
							{
								tenant: fixtureTenant,
								artifactId: result.artifact.id,
								artifactGeneration: result.artifact.generation,
								cacheKind: scope.kind,
								cacheName: scope.kind === 'named' ? scope.name : undefined,
								cacheGeneration: first.cache.generation,
								kind: 'listing',
								digest: fact.digest
							}
						],
						usage: { bytes: fact.size, blobs: 1 }
					});
				} finally {
					for (const restore of restores) {
						restore();
					}
				}
			})
	);

	it.each([
		'stale-parent',
		'stale-cache',
		'missing-fact',
		'missing-bytes',
		'suspended',
		'offboarding',
		'pre-activation'
	] as const)(
		'adoption RPC refuses %s without local publication state',
		(condition) =>
			withoutAlarmArming(async () => {
				const parent = await publishParent(token);
				const request = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const { fact, incarnation } = await recordFact(instance.context);
						const input = adoptionRequest(fact, parent);
						switch (condition) {
							case 'stale-parent': {
								return {
									...input,
									generation: narInfoGenerationSchema.parse(
										parent.generation + 1
									)
								};
							}
							case 'stale-cache': {
								return {
									...input,
									cacheGeneration: cacheGenerationSchema.parse(
										parent.cache.generation + 1
									)
								};
							}
							case 'missing-fact': {
								await instance.context.d1.delete(d1Schema.listingFact);
								break;
							}
							case 'missing-bytes': {
								await instance.context.env.BLOBS.delete(
									casObjectKey(fact.digest, incarnation)
								);
								break;
							}
							case 'suspended':
							case 'offboarding': {
								await instance.context.d1
									.update(d1Schema.tenant)
									.set({ status: condition })
									.where(eq(d1Schema.tenant.id, fixtureTenant));
								break;
							}
							case 'pre-activation': {
								await instance.context.d1
									.update(d1Schema.deploymentTransition)
									.set({ state: 'expanded' })
									.where(
										eq(
											d1Schema.deploymentTransition.id,
											'native-artifact-publication'
										)
									);
								break;
							}
						}
						return input;
					}
				);
				const before = await runInDurableObject(currentServer(), (instance) =>
					publicationState(instance.context)
				);
				const result = await adoptOne(request);
				const after = await runInDurableObject(currentServer(), (instance) =>
					publicationState(instance.context)
				);
				expect({ result, state: after }).toStrictEqual({
					result: {
						kind:
							condition === 'missing-fact'
								? 'fact-missing'
								: condition === 'missing-bytes'
									? 'bytes-missing'
									: 'unavailable'
					},
					state: before
				});
			})
	);

	it('adoption RPC preserves quota refusal and retires its pending reservation', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token);
			const request = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const { fact } = await recordFact(instance.context);
					const usage = await instance.context.d1
						.select({
							bytes: d1Schema.tenantUsage.bytes,
							casBytes: d1Schema.tenantUsage.casBytes
						})
						.from(d1Schema.tenantUsage)
						.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
						.get();
					if (usage === undefined) {
						throw new Error('The fixture quota row is missing');
					}
					await instance.context.d1
						.update(d1Schema.tenantUsage)
						.set({ quotaBytes: usage.bytes + usage.casBytes + fact.size - 1 })
						.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant));
					return adoptionRequest(fact, parent);
				}
			);
			const result = await adoptOne(request);
			const state = await runInDurableObject(
				currentServer(),
				async (instance) => {
					await instance.context.criticalSection(() =>
						new ArtifactRetirementService(instance.context).drainInSection()
					);
					return publicationState(instance.context);
				}
			);
			expect({ result, state }).toStrictEqual({
				result: { kind: 'over-quota' },
				state: {
					artifacts: [],
					listings: [],
					parents: [],
					roots: [],
					deletions: [],
					references: [],
					usage: { bytes: 0, blobs: 0 }
				}
			});
		}));

	it('adoption RPC rejects extra capabilities before creating publication state', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token);
			const request = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const { fact } = await recordFact(instance.context);
					return { ...adoptionRequest(fact, parent), owner: 'untrusted-owner' };
				}
			);
			const before = await runInDurableObject(currentServer(), (instance) =>
				publicationState(instance.context)
			);
			let failure: unknown;
			try {
				await adoptOne(request);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			const after = await runInDurableObject(currentServer(), (instance) =>
				publicationState(instance.context)
			);
			expect(after).toStrictEqual(before);
		}));
	it('adoption RPC keeps valid siblings after a captured cache refusal', () =>
		withoutAlarmArming(async () => {
			const scope = namedCache('adopt-sibling');
			await putTestCache(token, scope, 'private');
			const first = await publishParent(token, 'a');
			const second = await publishParent(token, 'b', scope);
			const { fact } = await runInDurableObject(currentServer(), (instance) =>
				recordFact(instance.context)
			);
			const invalid = {
				...adoptionRequest(fact, first),
				cacheGeneration: cacheGenerationSchema.parse(first.cache.generation + 1)
			};
			const outcomes = await currentServer().adoptNarListings([
				adoptionRequest(fact, first),
				invalid,
				adoptionRequest(fact, second)
			]);
			const left = outcomes[0];
			const right = outcomes[2];
			if (left?.kind !== 'published' || right?.kind !== 'published') {
				throw new Error('The valid siblings were not published');
			}
			const state = await runInDurableObject(currentServer(), (instance) =>
				publicationState(instance.context)
			);
			expect({
				outcomes,
				references: state.references.map((row) => ({
					artifactId: row.artifactId,
					cacheKind: row.cacheKind,
					cacheName: row.cacheName ?? undefined
				})),
				usage: state.usage
			}).toStrictEqual({
				outcomes: [
					{ kind: 'published', artifact: left.artifact },
					{ kind: 'unavailable' },
					{ kind: 'published', artifact: right.artifact }
				],
				references: [
					{
						artifactId: left.artifact.id,
						cacheKind: 'default',
						cacheName: undefined
					},
					{
						artifactId: right.artifact.id,
						cacheKind: 'named',
						cacheName: scope.name
					}
				],
				usage: { bytes: fact.size, blobs: 1 }
			});
		}));

	it('adoption RPC preserves a conflicting cache and publishes a valid sibling', () =>
		withoutAlarmArming(async () => {
			const scope = namedCache('adopt-conflict');
			await putTestCache(token, scope, 'private');
			const first = await publishParent(token);
			const second = await publishParent(token, 'b', scope);
			const { fact } = await runInDurableObject(currentServer(), (instance) =>
				recordFact(instance.context)
			);
			const seeded = await adoptOne(adoptionRequest(fact, first));
			if (seeded.kind !== 'published') {
				throw new Error('The conflicting fixture listing was not published');
			}
			const before = await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.artifacts)
					.set({ digest: sha256HexDigestSchema.parse('f'.repeat(64)) })
					.where(eq(schema.artifacts.id, seeded.artifact.id))
					.run();
				return publicationState(instance.context);
			});
			const outcomes = await currentServer().adoptNarListings([
				adoptionRequest(fact, first),
				adoptionRequest(fact, second)
			]);
			const sibling = outcomes[1];
			if (sibling?.kind !== 'published') {
				throw new Error('The sibling after a conflict was not published');
			}
			const after = await runInDurableObject(currentServer(), (instance) =>
				publicationState(instance.context)
			);
			expect({
				outcomes,
				preserved: {
					...after,
					artifacts: after.artifacts.filter(
						(row) => row.id !== sibling.artifact.id
					),
					listings: after.listings.filter(
						(row) => row.artifactId !== sibling.artifact.id
					),
					parents: after.parents.filter(
						(row) => row.artifactId !== sibling.artifact.id
					),
					references: after.references.filter(
						(row) => row.artifactId !== sibling.artifact.id
					)
				},
				siblingParents: after.parents.filter(
					(row) => row.artifactId === sibling.artifact.id
				)
			}).toStrictEqual({
				outcomes: [
					{ kind: 'conflict' },
					{ kind: 'published', artifact: sibling.artifact }
				],
				preserved: before,
				siblingParents: [
					{
						artifactId: sibling.artifact.id,
						artifactGeneration: sibling.artifact.generation,
						cacheId: second.cache.id,
						storePathHash: second.storePathHash,
						publicationGeneration: second.generation
					}
				]
			});
		}));

	it.each([0, 9])(
		'adoption RPC rejects a batch of %i requests before publication',
		(count) =>
			withoutAlarmArming(async () => {
				const parent = await publishParent(token);
				const { fact } = await runInDurableObject(currentServer(), (instance) =>
					recordFact(instance.context)
				);
				const requests = Array.from({ length: count }, () =>
					adoptionRequest(fact, parent)
				);
				const before = await runInDurableObject(currentServer(), (instance) =>
					publicationState(instance.context)
				);
				let failure: unknown;
				try {
					await currentServer().adoptNarListings(requests);
				} catch (error) {
					failure = error;
				}
				const after = await runInDurableObject(currentServer(), (instance) =>
					publicationState(instance.context)
				);
				expect({
					isRejected: failure instanceof Error,
					state: after
				}).toStrictEqual({ isRejected: true, state: before });
			})
	);
	it.each([
		{
			label: 'constrained remaining',
			subrequests: 50,
			shouldCompleteInOneBatch: false
		},
		{
			label: 'Free internal-service',
			subrequests: workersInvocationAllowances.free.subrequests,
			shouldCompleteInOneBatch: true
		},
		{
			label: 'Paid internal-service',
			subrequests: workersInvocationAllowances.paid.subrequests,
			shouldCompleteInOneBatch: true
		}
	])(
		'makes bounded progress through eight parents under the $label allowance',
		({ subrequests, shouldCompleteInOneBatch }) =>
			withoutAlarmArming(async () => {
				const parents = await Array.fromAsync('abcdfghj', (character) =>
					publishParent(token, character)
				);
				const { fact } = await runInDurableObject(currentServer(), (instance) =>
					recordFact(instance.context)
				);
				let pending = parents.map((parent) => adoptionRequest(fact, parent));
				const completed: NarListingAdoptionRequest[] = [];
				const spent: number[] = [];
				for (let pass = 0; pending.length > 0 && pass < 8; pass++) {
					const requests = pending;
					const result = await runInDurableObject(currentServer(), (instance) =>
						withSubrequestSlice(
							async () => {
								const before = subrequestsAvailable();
								const outcomes = await instance.adoptNarListings(requests);
								return { outcomes, spent: before - subrequestsAvailable() };
							},
							{ subrequests, reserve: 8 }
						)
					);
					const next: NarListingAdoptionRequest[] = [];
					for (const [index, outcome] of result.outcomes.entries()) {
						const request = requests[index];
						if (request === undefined) {
							throw new Error('Unexpected adoption outcome');
						}
						if (
							outcome.kind === 'published' ||
							outcome.kind === 'already-present'
						) {
							completed.push(request);
							continue;
						}
						if (outcome.kind !== 'capacity') {
							throw new Error(`Unexpected adoption refusal: ${outcome.kind}`);
						}
						next.push(request);
					}
					if (next.length >= pending.length) {
						throw new Error(
							'An adoption batch made no progress within its allowance'
						);
					}
					pending = next;
					spent.push(result.spent);
				}
				const state = await runInDurableObject(currentServer(), (instance) =>
					publicationState(instance.context)
				);
				expect({
					completed: completed
						.map((item) => item.storePathHash)
						.toSorted(byCodeUnit),
					pending,
					parents: state.parents
						.map((item) => item.storePathHash)
						.toSorted(byCodeUnit),
					usage: state.usage
				}).toStrictEqual({
					completed: parents
						.map((parent) => parent.storePathHash)
						.toSorted(byCodeUnit),
					pending: [],
					parents: parents
						.map((parent) => parent.storePathHash)
						.toSorted(byCodeUnit),
					usage: { bytes: fact.size, blobs: 1 }
				});
				expect(Math.max(...spent)).toBeLessThanOrEqual(subrequests);
				expect(spent.length === 1).toBe(shouldCompleteInOneBatch);
			})
	);
	it.each(
		[
			{ label: 'default', scope: defaultCache() },
			{ label: 'named', scope: namedCache('queued-adopt') }
		].flatMap((cache) =>
			(['parents-first', 'fact-first'] as const).flatMap((order) =>
				(['retained', 'expired'] as const).map((retention) => ({
					...cache,
					order,
					retention
				}))
			)
		)
	)(
		'publishes queued adoption through the real Worker and DO for $label, $order, $retention input',
		({ scope, order, retention }) =>
			withoutAlarmArming(async () => {
				for (const id of [
					'listing-adoption-capture',
					'listing-adoption-work',
					'listing-adoption-parents',
					'listing-adoption-tasks',
					'listing-adoption-fact-seed',
					'listing-adoption-parent-seed',
					'listing-adoption-seed-dispatch'
				] as const) {
					await recordTransition(id, 'complete');
				}
				if (scope.kind === 'named') {
					await putTestCache(token, scope, 'private');
				}
				const sent: (
					ListingAdoptionWorkMessage | ListingAdoptionQueueMessage
				)[] = [];
				const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
				const queue: Queue<
					ListingAdoptionWorkMessage | ListingAdoptionQueueMessage
				> = {
					metrics: () => Promise.resolve(metadata.metrics),
					send: (body) => {
						sent.push(body);
						return Promise.resolve({ metadata });
					},
					sendBatch: (entries) => {
						sent.push(...Array.from(entries, (entry) => entry.body));
						return Promise.resolve({ metadata });
					}
				};
				const namespace = new Proxy(env.CUPBOARD_DO, {
					get(target, property) {
						if (property === 'idFromName') {
							return () => currentServer().id;
						}
						if (property === 'get') {
							return () => currentServer();
						}
						const value: unknown = Reflect.get(target, property, target);
						return value;
					}
				});
				const workerEnv = {
					...env,
					...testControlEnv,
					CUPBOARD_DO: namespace,
					ARTIFACT_QUEUE: queue
				};
				const actions: string[] = [];
				let processed = 0;
				const drain = async () => {
					await new ListingAdoptionWorkQueue({
						database: env.CUPBOARD_DB,
						queue,
						wakeHistorical: () =>
							queue.send({ kind: 'listing-adoption-dispatch' }),
						serverFor: () => currentServer()
					}).start();
					for (let turn = 0; turn < 64; turn++) {
						const body = sent.shift();
						if (body === undefined) {
							return;
						}
						processed++;
						const message: Message = {
							id: `queued-adopt-${processed.toString()}`,
							body,
							timestamp: new Date(),
							attempts: 1,
							ack: () => {
								actions.push('ack');
							},
							retry: () => {
								actions.push('retry');
							}
						};
						await withSubrequestSlice(
							() =>
								handleWorkerQueue(
									{
										queue: 'cupboard-artifacts',
										messages: [message],
										metadata,
										ackAll: () => {
											throw new Error('Unexpected batch acknowledgement');
										},
										retryAll: () => {
											throw new Error('Unexpected batch retry');
										}
									},
									workerEnv,
									new NarReadBufferPool()
								),
							{ subrequests: 50, reserve: 8 }
						);
					}
					throw new Error('The bounded adoption fixture did not drain');
				};
				const captured: {
					fact?: NarListingFact;
					parents?: readonly [
						ArtifactPublicationParent,
						ArtifactPublicationParent
					];
				} = {};
				const publishParents = async () => {
					captured.parents = [
						await publishParent(token, 'a', scope),
						await publishParent(token, 'b', scope)
					];
				};
				const publishFact = async () => {
					const stored = await runInDurableObject(currentServer(), (instance) =>
						recordFact(instance.context)
					);
					captured.fact = stored.fact;
				};
				const steps: readonly [() => Promise<void>, () => Promise<void>] =
					order === 'parents-first'
						? [publishParents, publishFact]
						: [publishFact, publishParents];
				await steps[0]();
				await drain();
				const initial = await runInDurableObject(currentServer(), (instance) =>
					publicationState(instance.context)
				);
				expect({
					artifacts: initial.artifacts,
					references: initial.references,
					usage: initial.usage
				}).toStrictEqual({
					artifacts: [],
					references: [],
					usage: { bytes: 0, blobs: 0 }
				});
				await steps[1]();
				if (retention === 'expired') {
					const result = await runInDurableObject(
						currentServer(),
						async (instance) => {
							const database = instance.context.d1;
							const position = await database
								.select()
								.from(d1Schema.listingAdoptionCaptureState)
								.get();
							if (position === undefined) {
								throw new Error('Expected the adoption capture position');
							}
							await database
								.insert(d1Schema.listingAdoptionFactSeed)
								.values({ id: 1, isComplete: true });
							await database.insert(d1Schema.listingAdoptionParentSeed).values([
								{ cacheKind: 'default', isComplete: true },
								{ cacheKind: 'named', isComplete: true }
							]);
							await database
								.delete(d1Schema.listingAdoptionCaptureEvent)
								.where(
									lte(d1Schema.listingAdoptionCaptureEvent.id, position.latest)
								);
							await database
								.update(d1Schema.listingAdoptionCaptureState)
								.set({ prunedThrough: position.latest });
							return {
								floor: position.latest,
								consumer: await new ListingAdoptionConsumerStore(
									database
								).advance()
							};
						}
					);
					expect(result.consumer).toStrictEqual({
						kind: 'expired',
						prunedThrough: result.floor
					});
				}
				if (captured.fact === undefined || captured.parents === undefined) {
					throw new Error('Expected both availability sources');
				}
				const { fact, parents } = captured;
				const [first, second] = parents;
				const io = { get: 0, put: 0 };
				const restores: (() => void)[] = [];
				await runInDurableObject(currentServer(), (instance) => {
					const get = vi
						.spyOn(instance.context.env.BLOBS, 'get')
						.mockImplementation(() => {
							io.get++;
							throw new Error('Queued adoption must not read payload bytes');
						});
					const put = vi
						.spyOn(instance.context.env.BLOBS, 'put')
						.mockImplementation(() => {
							io.put++;
							throw new Error('Queued adoption must not upload payload bytes');
						});
					restores.push(
						() => {
							get.mockRestore();
						},
						() => {
							put.mockRestore();
						}
					);
				});
				try {
					await drain();
					const state = await runInDurableObject(currentServer(), (instance) =>
						publicationState(instance.context)
					);
					expect({
						io,
						queued: sent,
						actions,
						artifacts: state.artifacts.map((row) => ({
							kind: row.kind,
							state: row.state,
							digest: row.digest
						})),
						parents: state.parents
							.map((row) => ({
								cacheId: row.cacheId,
								storePathHash: row.storePathHash,
								publicationGeneration: row.publicationGeneration
							}))
							.toSorted((left, right) =>
								byCodeUnit(left.storePathHash, right.storePathHash)
							),
						references: state.references.map((row) => ({
							tenant: row.tenant,
							cacheKind: row.cacheKind,
							cacheName: row.cacheName ?? undefined,
							cacheGeneration: row.cacheGeneration,
							kind: row.kind,
							digest: row.digest
						})),
						usage: state.usage
					}).toStrictEqual({
						io: { get: 0, put: 0 },
						queued: [],
						actions: Array.from({ length: processed }, () => 'ack'),
						artifacts: [
							{ kind: 'listing', state: 'live', digest: fact.digest }
						],
						parents: [first, second].map((parent) => ({
							cacheId: parent.cache.id,
							storePathHash: parent.storePathHash,
							publicationGeneration: parent.generation
						})),
						references: [
							{
								tenant: fixtureTenant,
								cacheKind: scope.kind,
								cacheName: scope.kind === 'named' ? scope.name : undefined,
								cacheGeneration: first.cache.generation,
								kind: 'listing',
								digest: fact.digest
							}
						],
						usage: { bytes: fact.size, blobs: 1 }
					});
				} finally {
					for (const restore of restores) {
						restore();
					}
				}
				const response = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const result = await new NarListingReadService(
							instance.context
						).serve(
							new Request('https://cache.example/listing'),
							scope,
							first.storePathHash
						);
						return { status: result.status, body: await result.text() };
					}
				);
				expect(response).toStrictEqual({
					status: 200,
					body: new TextDecoder().decode(bytes)
				});
			})
	);
});
