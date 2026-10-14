import {
	cacheGenerationSchema,
	type CacheScope,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	artifactGenerationSchema,
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { runInDurableObject } from 'cloudflare:test';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { ListingFactStore } from '../db/listing-facts.ts';
import * as schema from '../db/schema.ts';
import { ListingFactConflictError } from '../errors.ts';
import { casObjectKey } from '../http/http.ts';
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
});
