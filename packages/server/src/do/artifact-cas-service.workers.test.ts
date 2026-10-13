import {
	cacheGenerationSchema,
	cacheNameSchema,
	cachePrioritySchema,
	narInfoGenerationSchema,
	predicateTypeSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	artifactGenerationSchema,
	artifactIdSchema,
	type ArtifactKind,
	artifactKinds
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	ArtifactReferenceConflictError,
	ArtifactStorageMigrationPendingError
} from '../errors.ts';
import { casObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	defaultCache,
	initialise,
	recordTransition,
	resetTestServer,
	tenantUsageRow,
	withoutAlarmArming
} from '../test-support.ts';

import { ArtifactCasService } from './artifact-cas-service.ts';
import { AttestationCasService } from './attestation-cas-service.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import type { ServerContext } from './context.ts';

const id = artifactIdSchema.parse('00000000-0000-4000-8000-000000000001');
const generation = artifactGenerationSchema.parse(1);

async function createArtifact(
	context: ServerContext,
	kind: ArtifactKind = 'listing'
) {
	const bytes = new TextEncoder().encode('native artifact');
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
	const incarnation = await new CasObjectStore(
		context.d1,
		context.env.BLOBS
	).promote({ digest, size: bytes.byteLength, bytes });
	const cache = context.cacheRepository.require(defaultCache());
	const createdAt = isoTimestamp(new Date());
	const expiresAt = isoTimestamp(new Date(Date.now() + 30 * 86_400_000));
	context.db
		.insert(schema.artifacts)
		.values({
			id,
			generation,
			cacheId: cache.id,
			kind,
			digest,
			publicationIncarnation: incarnation,
			state: 'pending',
			createdAt,
			expiresAt
		})
		.run();
	await context.d1
		.update(d1Schema.casObject)
		.set({ deleteAfter: createdAt })
		.where(eq(d1Schema.casObject.digest, digest));
	return { digest, size: bytes.byteLength, incarnation, cache, createdAt };
}

async function reservationState(context: ServerContext) {
	const [presence, references, objects] = await context.d1.batch([
		context.d1.select().from(d1Schema.tenantCasBlob),
		context.d1.select().from(d1Schema.artifactReference),
		context.d1.select().from(d1Schema.casObject)
	]);
	return {
		usage: await tenantUsageRow(),
		presence,
		references: references.map((row) => ({
			...row,
			cacheName: row.cacheName ?? undefined
		})),
		objects: objects.map((row) => ({
			...row,
			deleteAfter: row.deleteAfter ?? undefined
		}))
	};
}

describe('artifact CAS reservation', () => {
	beforeEach(async () => {
		await resetTestServer();
		await withoutAlarmArming(initialise);
		await recordTransition('native-artifact-storage', 'expanded');
	});

	it.each(artifactKinds)(
		'reserves %s by reference without reading or uploading bytes',
		(kind) =>
			withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						const artifact = await createArtifact(context, kind);
						const get = vi.spyOn(context.env.BLOBS, 'get');
						const put = vi.spyOn(context.env.BLOBS, 'put');
						try {
							const service = new ArtifactCasService(context);
							const first = await service.reserveInSection(id, generation);
							const repeated = await service.reserveInSection(id, generation);
							expect({
								first,
								repeated,
								...(await reservationState(context)),
								gets: get.mock.calls.length,
								puts: put.mock.calls.length
							}).toStrictEqual({
								first: 'referenced',
								repeated: 'already-present',
								usage: {
									bytes: 0,
									narinfos: 0,
									blobs: 0,
									casBytes: artifact.size,
									casBlobs: 1,
									quotaBytes: undefined
								},
								presence: [
									{
										tenant: fixtureTenant,
										digest: artifact.digest,
										size: artifact.size
									}
								],
								references: [
									{
										tenant: fixtureTenant,
										artifactId: id,
										artifactGeneration: generation,
										cacheKind: 'default',
										cacheName: undefined,
										cacheGeneration: artifact.cache.generation,
										kind,
										digest: artifact.digest,
										createdAt: artifact.createdAt
									}
								],
								objects: [
									{
										digest: artifact.digest,
										size: artifact.size,
										incarnation: artifact.incarnation,
										storedAt: artifact.createdAt,
										deleteAfter: undefined
									}
								],
								gets: 0,
								puts: 0
							});
						} finally {
							get.mockRestore();
							put.mockRestore();
						}
					});
				})
			)
	);

	it.each([
		'cache-generation',
		'cas-incarnation',
		'storage-readiness'
	] as const)(
		'rejects a changed %s after R2 head without creating a charge',
		(changed) =>
			withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						const artifact = await createArtifact(context);
						const originalHead = context.env.BLOBS.head.bind(context.env.BLOBS);
						let changedState:
							Awaited<ReturnType<typeof reservationState>> | undefined;
						const head = vi
							.spyOn(context.env.BLOBS, 'head')
							.mockImplementation(async (key) => {
								const object = await originalHead(key);
								if (changed === 'cache-generation') {
									await context.d1
										.update(d1Schema.cacheLifecycle)
										.set({
											generation: cacheGenerationSchema.parse(
												artifact.cache.generation + 1
											)
										})
										.where(eq(d1Schema.cacheLifecycle.tenant, fixtureTenant));
								} else if (changed === 'storage-readiness') {
									await context.d1
										.delete(d1Schema.deploymentTransition)
										.where(
											eq(
												d1Schema.deploymentTransition.id,
												'native-artifact-storage'
											)
										);
								} else {
									await context.d1
										.update(d1Schema.casObject)
										.set({ incarnation: artifact.incarnation + 1 })
										.where(eq(d1Schema.casObject.digest, artifact.digest));
								}
								changedState = await reservationState(context);
								return object;
							});
						try {
							const outcome = await new ArtifactCasService(
								context
							).reserveInSection(id, generation);
							expect({
								outcome,
								state: await reservationState(context)
							}).toStrictEqual({ outcome: 'unavailable', state: changedState });
						} finally {
							head.mockRestore();
						}
					});
				})
			)
	);

	it('preserves deletion grace and accounting when the immutable object is missing', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await createArtifact(context);
					await context.env.BLOBS.delete(
						casObjectKey(artifact.digest, artifact.incarnation)
					);
					const before = await reservationState(context);
					const outcome = await new ArtifactCasService(
						context
					).reserveInSection(id, generation);
					expect({
						outcome,
						state: await reservationState(context)
					}).toStrictEqual({ outcome: 'unavailable', state: before });
				});
			})
		));

	it('refuses an over-quota reservation without changing references or deletion grace', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await createArtifact(context);
					await context.d1
						.update(d1Schema.tenantUsage)
						.set({ quotaBytes: artifact.size - 1 })
						.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant));
					const before = await reservationState(context);
					const outcome = await new ArtifactCasService(
						context
					).reserveInSection(id, generation);
					expect({
						outcome,
						state: await reservationState(context)
					}).toStrictEqual({ outcome: 'over-quota', state: before });
				});
			})
		));
	it('projects the artifact into its registered named cache', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await createArtifact(context);
					const scope = {
						kind: 'named' as const,
						name: cacheNameSchema.parse('builds')
					};
					const cache = await new CacheRegistrationService(
						context
					).createInSection(scope, {
						access: 'private',
						priority: cachePrioritySchema.parse(30)
					});
					context.db
						.update(schema.artifacts)
						.set({ cacheId: cache.id })
						.where(eq(schema.artifacts.id, id))
						.run();
					const outcome = await new ArtifactCasService(
						context
					).reserveInSection(id, generation);
					const rows = await context.d1
						.select()
						.from(d1Schema.artifactReference);
					expect({ outcome, rows }).toStrictEqual({
						outcome: 'referenced',
						rows: [
							{
								tenant: fixtureTenant,
								artifactId: id,
								artifactGeneration: generation,
								cacheKind: 'named',
								cacheName: scope.name,
								cacheGeneration: cache.generation,
								kind: 'listing',
								digest: artifact.digest,
								createdAt: artifact.createdAt
							}
						]
					});
				});
			})
		));

	it('refuses a conflicting immutable artifact generation without changing its existing charge', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					await createArtifact(context);
					const service = new ArtifactCasService(context);
					await service.reserveInSection(id, generation);
					context.db
						.update(schema.artifacts)
						.set({ kind: 'listing-proof' })
						.where(eq(schema.artifacts.id, id))
						.run();
					const before = await reservationState(context);
					await expect(
						service.reserveInSection(id, generation)
					).rejects.toThrow(ArtifactReferenceConflictError);
					expect(await reservationState(context)).toStrictEqual(before);
				});
			})
		));

	it.each(['retired', 'expired', 'stale-generation'] as const)(
		'rejects a %s artifact without mutating CAS accounting',
		(invalid) =>
			withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						await createArtifact(context);
						if (invalid !== 'stale-generation') {
							const change =
								invalid === 'retired'
									? { state: 'retired' as const }
									: { expiresAt: isoTimestamp(new Date()) };
							context.db
								.update(schema.artifacts)
								.set(change)
								.where(eq(schema.artifacts.id, id))
								.run();
						}
						const before = await reservationState(context);
						const capturedGeneration =
							invalid === 'stale-generation'
								? artifactGenerationSchema.parse(2)
								: generation;
						const outcome = await new ArtifactCasService(
							context
						).reserveInSection(id, capturedGeneration);
						expect({
							outcome,
							state: await reservationState(context)
						}).toStrictEqual({ outcome: 'unavailable', state: before });
					});
				})
			)
	);
	it('credits the digest only after its last artifact generation is removed', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await createArtifact(context);
					const service = new ArtifactCasService(context);
					await service.reserveInSection(id, generation);
					const nextGeneration = artifactGenerationSchema.parse(2);
					context.db
						.update(schema.artifacts)
						.set({ generation: nextGeneration, kind: 'listing-proof' })
						.where(eq(schema.artifacts.id, id))
						.run();
					await service.reserveInSection(id, nextGeneration);
					const before = await reservationState(context);
					const captured = {
						artifactId: id,
						artifactGeneration: generation,
						digest: artifact.digest,
						cache: artifact.cache
					};
					const outcome = await service.removeCapturedInSection(captured);
					const remaining = await reservationState(context);
					expect({ outcome, state: remaining }).toStrictEqual({
						outcome: 'removed',
						state: {
							...before,
							references: before.references.filter(
								(row) => row.artifactGeneration === nextGeneration
							)
						}
					});
					const repeated = await service.removeCapturedInSection(captured);
					expect({
						outcome: repeated,
						state: await reservationState(context)
					}).toStrictEqual({ outcome: 'already-absent', state: remaining });
					const final = await service.removeCapturedInSection({
						...captured,
						artifactGeneration: nextGeneration
					});
					expect({
						outcome: final,
						state: await reservationState(context)
					}).toStrictEqual({
						outcome: 'removed',
						state: {
							...remaining,
							references: [],
							presence: [],
							usage: { ...remaining.usage, casBytes: 0, casBlobs: 0 }
						}
					});
				});
			})
		));

	it('keeps the shared charge while an attestation still references the digest', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await createArtifact(context);
					const service = new ArtifactCasService(context);
					await service.reserveInSection(id, generation);
					await new AttestationCasService(context).reserveReferenceAndCharge(
						{
							cache: defaultCache(),
							storePathHash: storePathHashSchema.parse('a'.repeat(32)),
							generation: narInfoGenerationSchema.parse(0),
							predicateType: predicateTypeSchema.parse(
								'https://slsa.dev/provenance/v1'
							),
							digest: artifact.digest
						},
						artifact.size
					);
					const before = await reservationState(context);
					const outcome = await service.removeCapturedInSection({
						artifactId: id,
						artifactGeneration: generation,
						digest: artifact.digest,
						cache: artifact.cache
					});
					expect({
						outcome,
						state: await reservationState(context)
					}).toStrictEqual({
						outcome: 'removed',
						state: { ...before, references: [] }
					});
				});
			})
		));

	it('preserves a reference and charge when removal captures a different cache generation', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await createArtifact(context);
					const service = new ArtifactCasService(context);
					await service.reserveInSection(id, generation);
					const before = await reservationState(context);
					const outcome = await service.removeCapturedInSection({
						artifactId: id,
						artifactGeneration: generation,
						digest: artifact.digest,
						cache: {
							...artifact.cache,
							generation: cacheGenerationSchema.parse(
								artifact.cache.generation + 1
							)
						}
					});
					expect({
						outcome,
						state: await reservationState(context)
					}).toStrictEqual({ outcome: 'already-absent', state: before });
				});
			})
		));

	it('defers stale missing-object removal after a physical repair', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await createArtifact(context);
					const service = new ArtifactCasService(context);
					await service.reserveInSection(id, generation);
					await context.env.BLOBS.delete(
						casObjectKey(artifact.digest, artifact.incarnation)
					);
					const bytes = new TextEncoder().encode('native artifact');
					await new CasObjectStore(context.d1, context.env.BLOBS).promote(
						{ digest: artifact.digest, size: artifact.size, bytes },
						{ restoreMissingObject: true }
					);
					const before = await reservationState(context);
					const outcome = await service.removeCapturedInSection(
						{
							artifactId: id,
							artifactGeneration: generation,
							digest: artifact.digest,
							cache: artifact.cache
						},
						artifact.incarnation
					);
					expect({
						outcome,
						state: await reservationState(context)
					}).toStrictEqual({ outcome: 'deferred', state: before });
				});
			})
		));

	it('refuses artifact deletion before compatible reference storage is active', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await createArtifact(context);
					const service = new ArtifactCasService(context);
					await service.reserveInSection(id, generation);
					await context.d1
						.delete(d1Schema.deploymentTransition)
						.where(
							eq(d1Schema.deploymentTransition.id, 'native-artifact-storage')
						);
					const before = await reservationState(context);
					await expect(
						service.removeCapturedInSection({
							artifactId: id,
							artifactGeneration: generation,
							digest: artifact.digest,
							cache: artifact.cache
						})
					).rejects.toThrow(ArtifactStorageMigrationPendingError);
					expect(await reservationState(context)).toStrictEqual(before);
				});
			})
		));
});
