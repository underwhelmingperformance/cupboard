import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	storedReferencesSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import {
	publicationCaptureBeginRequestSchema,
	publicationResultIdentitySchema
} from '@cupboard/protocol/publication-manifests';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { ORPCError } from '@orpc/server';
import { runInDurableObject } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { StoredReferencesInvalidError } from '../errors.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedWorkerFetch,
	cacheScopedPath,
	fixtureWorkerServer,
	initialiseViaWorker,
	namedCache,
	pushPathToTenant,
	putWorkerTestCache,
	resetTestServer,
	verifiablePath,
	withoutAlarmArming
} from '../test-support.ts';

import { ServerContext } from './context.ts';
import { withOperationCost } from './operation-cost.ts';
import { PublicationManifestAuthority } from './publication-manifest-authority.ts';
import { PublicationManifestCaptureService } from './publication-manifest-capture.ts';
import { PublicationManifestRepository } from './publication-manifest-repository.ts';
import {
	type ReuseViewArbitrationSnapshot,
	ReuseViewLookupService
} from './reuse-view-lookup-service.ts';
import {
	committedPath,
	insertUnbackedRow,
	setView
} from './reuse-view-read.test-support.ts';

const counter = { value: 0 };
async function fixture(
	access: 'public' | 'private' = 'public',
	references?: string[]
) {
	counter.value += 1;
	const destination = namedCache(
		`bootstrap-destination-${String(counter.value)}`
	);
	const source = namedCache(`bootstrap-source-${String(counter.value)}`);
	await committedPath(`bootstrap-${String(counter.value)}`, source, {
		access,
		references
	});
	const grants = authorizationDetailsSchema.parse([
		{ type: 'cupboard_cache', cache: destination, actions: ['upload:commit'] },
		{ type: 'cupboard_cache', cache: source, actions: ['cache:content-read'] }
	]);
	const result = await runInDurableObject(fixtureWorkerServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(source);
		const row = instance.context.db
			.select()
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, cache.id))
			.get();
		if (row === undefined) {
			throw new Error('Missing fixture');
		}
		return publicationResultIdentitySchema.parse({
			cache: source,
			cacheGeneration: cache.generation,
			storePath: row.storePath,
			narHash: row.narHash,
			generation: row.generation
		});
	});
	return { destination, source, grants, result };
}

async function lookupState() {
	return runInDurableObject(fixtureWorkerServer(), async (instance) => {
		const { db, d1 } = instance.context;
		return {
			caches: db.select().from(schema.cacheIdentities).all(),
			versions: db.select().from(schema.narInfos).all(),
			views: db.select().from(schema.reuseViews).all(),
			selectors: db.select().from(schema.nativeReuseViewSelectors).all(),
			publications: db.select().from(schema.resultPublications).all(),
			members: db.select().from(schema.resultPublicationMembers).all(),
			manifests: db.select().from(schema.publicationManifests).all(),
			portableMembers: db
				.select()
				.from(schema.publicationManifestMembers)
				.all(),
			operations: db.select().from(schema.publicationManifestOperations).all(),
			pages: db.select().from(schema.publicationManifestOperationPages).all(),
			cardinalities: db
				.select()
				.from(schema.publicationManifestCardinalities)
				.all(),
			holds: db.select().from(schema.publicationManifestWorkHolds).all(),
			admissions: db.select().from(schema.publicationManifestAdmissions).all(),
			availabilityClock: db
				.select()
				.from(schema.publicationManifestAvailabilityClock)
				.all(),
			availabilityRevisions: db
				.select()
				.from(schema.publicationManifestAvailabilityRevisions)
				.all(),
			availabilityIntents: db
				.select()
				.from(schema.publicationManifestAvailabilityIntents)
				.all(),
			lifecycleIntents: db
				.select()
				.from(schema.publicationManifestLifecycleIntents)
				.all(),
			pendingUploads: db.select().from(schema.pendingUploads).all(),
			receipts: db.select().from(schema.confirmationReceipts).all(),
			roots: db.select().from(schema.retentionRoots).all(),
			targets: db.select().from(schema.retentionRootTargets).all(),
			grace: db.select().from(schema.retentionGrace).all(),
			edges: await d1.select().from(d1Schema.blobReference).all(),
			usage: await d1.select().from(d1Schema.tenantUsage).all(),
			ownership: await d1.select().from(d1Schema.tenantBlob).all(),
			blobs: await d1.select().from(d1Schema.blobState).all(),
			lifecycles: await d1.select().from(d1Schema.cacheLifecycle).all()
		};
	});
}

async function captureResult(f: Awaited<ReturnType<typeof fixture>>) {
	onTestFinished(() =>
		runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.source);
			const association = instance.context.db
				.select()
				.from(schema.resultPublications)
				.where(eq(schema.resultPublications.cacheId, cache.id))
				.get();
			instance.context.db
				.delete(schema.resultPublications)
				.where(eq(schema.resultPublications.cacheId, cache.id))
				.run();
			instance.context.db
				.delete(schema.resultPublicationMembers)
				.where(eq(schema.resultPublicationMembers.cacheId, cache.id))
				.run();
			if (association === undefined) {
				return;
			}

			instance.context.db
				.delete(schema.publicationManifestMembers)
				.where(eq(schema.publicationManifestMembers.digest, association.digest))
				.run();
			instance.context.db
				.delete(schema.publicationManifests)
				.where(eq(schema.publicationManifests.digest, association.digest))
				.run();
		})
	);
	const grants = authorizationDetailsSchema.parse([
		{ type: 'cupboard_cache', cache: f.source, actions: ['upload:commit'] }
	]);
	return runInDurableObject(fixtureWorkerServer(), async (instance) => {
		const service = new PublicationManifestCaptureService(instance.context);
		const operation = await service.captureBegin(
			f.source,
			grants,
			publicationCaptureBeginRequestSchema.parse({
				result: {
					storePath: f.result.storePath,
					narHash: f.result.narHash,
					generation: f.result.generation
				},
				expectedCacheGeneration: f.result.cacheGeneration,
				requestId: crypto.randomUUID(),
				origin: 'build-selection',
				memberCount: 1
			})
		);
		if (operation.kind !== 'staging') {
			throw new Error('Expected staging');
		}
		await service.capturePage(f.source, grants, {
			operationId: operation.operationId,
			page: 0,
			members: [
				{
					storePath: f.result.storePath,
					narHash: f.result.narHash,
					generation: f.result.generation
				}
			]
		});
		let response = await service.captureSeal(f.source, grants, {
			operationId: operation.operationId
		});
		for (let step = 0; response.kind === 'pending' && step < 8; step += 1) {
			response = await service.captureSeal(f.source, grants, {
				operationId: operation.operationId
			});
		}
		if (response.kind !== 'captured') {
			throw new Error('Expected captured publication');
		}
		return response.publication;
	});
}

async function removeSourcePath(f: Awaited<ReturnType<typeof fixture>>) {
	const response = await authorisedWorkerFetch(
		cacheScopedPath(f.source, `/paths/${StorePath.hash(f.result.storePath)}`),
		await initialiseViaWorker(),
		{ method: 'DELETE' }
	);
	expect(response.status).toBe(200);
}

describe('PublicationManifestRepository bootstrap lookup', () => {
	beforeEach(resetTestServer);
	it('preserves bare target order and distinguishes unavailable from missing without fabricating result identities', async () => {
		const f = await fixture();
		const absent = storePathSchema.parse(
			'/nix/store/00000000000000000000000000000000-absent'
		);
		const response = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) =>
				new PublicationManifestRepository(instance.context).lookup(
					f.destination,
					f.grants,
					{
						source: { cache: f.source },
						results: [{ storePath: absent }, { storePath: f.result.storePath }]
					}
				)
		);
		expect(response).toStrictEqual({
			entries: [
				{ kind: 'unavailable', storePath: absent },
				{ kind: 'missing', result: f.result }
			]
		});
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			expect(
				instance.context.cacheRepository.resolve(f.destination)
			).toBeUndefined();
		});
	});
	it('fences supplied identities instead of treating an absent or changed exact result as unavailable', async () => {
		const f = await fixture();
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const repository = new PublicationManifestRepository(instance.context);
			await expect(
				repository.lookup(f.destination, f.grants, {
					source: {
						cache: f.source,
						expectedCacheGeneration: cacheGenerationSchema.parse(
							f.result.cacheGeneration + 1
						)
					},
					results: [{ storePath: f.result.storePath }]
				})
			).rejects.toMatchObject({ code: 'PUBLICATION_GENERATION_CONFLICT' });
			await expect(
				repository.lookup(f.destination, f.grants, {
					source: { cache: f.source },
					results: [
						{
							storePath: f.result.storePath,
							generation: narInfoGenerationSchema.parse(f.result.generation + 1)
						}
					]
				})
			).rejects.toMatchObject({ code: 'PUBLICATION_RESULT_CHANGED' });
			await expect(
				repository.lookup(f.destination, f.grants, {
					source: { cache: f.source },
					results: [
						{
							storePath: storePathSchema.parse(
								'/nix/store/00000000000000000000000000000000-absent'
							),
							narHash: f.result.narHash
						}
					]
				})
			).rejects.toMatchObject({ code: 'PUBLICATION_RESULT_CHANGED' });
		});
	});
	it('permits an authorised first promotion source without creating its destination and truthfully fences absent destination state', async () => {
		const f = await fixture('private');
		const snapshot = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const authority = new PublicationManifestAuthority(instance.context);
				const snapshot = authority.resolveExact(
					f.destination,
					f.grants,
					f.result
				);
				expect(snapshot.destination).toBeUndefined();
				expect(snapshot.destinationScope).toStrictEqual(f.destination);
				return snapshot;
			}
		);
		await putWorkerTestCache(
			await initialiseViaWorker(),
			f.destination,
			'public'
		);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			expect(() =>
				new PublicationManifestAuthority(instance.context).revalidate(
					snapshot,
					f.grants
				)
			).toThrow(expect.objectContaining({ code: 'PUBLICATION_SCOPE_CHANGED' }));
		});
	});
	it('never uses the foreign source as destination to grant private-source permission, even for unavailable targets', async () => {
		const f = await fixture('private');
		const noRead = authorizationDetailsSchema.parse([
			{
				type: 'cupboard_cache',
				cache: f.destination,
				actions: ['upload:commit']
			}
		]);
		await expect(
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestRepository(instance.context).lookup(
					f.destination,
					noRead,
					{
						source: { cache: f.source },
						results: [{ storePath: f.result.storePath }]
					}
				)
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
	it('resolves a view-only source and returns its fenced current revision for later promotion', async () => {
		const f = await fixture('private');
		const view = reuseViewNameSchema.parse(
			`bootstrap-${String(counter.value)}`
		);
		await setView([{ kind: 'named', name: f.source.name }], view, 'private');
		const grants = authorizationDetailsSchema.parse([
			{
				type: 'cupboard_cache',
				cache: f.destination,
				actions: ['upload:commit']
			},
			{ type: 'cupboard_view', view, actions: ['view:content-read'] }
		]);
		const response = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) =>
				new PublicationManifestRepository(instance.context).lookup(
					f.destination,
					grants,
					{
						source: { selector: { view } },
						results: [{ storePath: f.result.storePath }]
					}
				)
		);
		expect(response).toMatchObject({
			entries: [{ kind: 'missing', result: f.result }],
			sourceSelector: { view }
		});
		expect(response.sourceSelector?.expectedRevision).toBeGreaterThan(0);
		await setView(
			[{ kind: 'named', name: namedCache('bootstrap-no-members').name }],
			view,
			'private'
		);
		await expect(
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestRepository(instance.context).lookup(
					f.destination,
					grants,
					{
						source: { selector: response.sourceSelector },
						results: [{ storePath: f.result.storePath }]
					}
				)
			)
		).rejects.toMatchObject({ code: 'PUBLICATION_SCOPE_CHANGED' });
	});
	it.each(['view-only', 'first-cache', 'other-cache'] as const)(
		'does not arbitrate disagreeing view NARs into a fabricated or combined result for %s',
		async (sourceConstraint) => {
			const f = await fixture();
			const other = namedCache(`bootstrap-conflict-${String(counter.value)}`);
			await committedPath('bootstrap-conflicting-nar', other);
			const view = reuseViewNameSchema.parse(
				`bootstrap-conflict-${String(counter.value)}`
			);
			await setView(
				[
					{ kind: 'named', name: f.source.name },
					{ kind: 'named', name: other.name }
				],
				view
			);
			const before = await lookupState();
			const response = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					new PublicationManifestRepository(instance.context).lookup(
						f.destination,
						f.grants,
						{
							source: {
								selector: { view },
								...(sourceConstraint !== 'view-only' && {
									cache: sourceConstraint === 'first-cache' ? f.source : other
								})
							},
							results: [{ storePath: f.result.storePath }]
						}
					)
			);
			expect(response).toStrictEqual({
				entries: [{ kind: 'unavailable', storePath: f.result.storePath }],
				sourceSelector: {
					view,
					expectedRevision: before.views.find((row) => row.name === view)
						?.revision
				}
			});
		}
	);
	it.each(['missing', 'recorded'] as const)(
		'selects the original agreeing higher-ID concrete cache with a %s association',
		async (association) => {
			const f = await fixture();
			const other = namedCache(`constrained-agreeing-${String(counter.value)}`);
			await committedPath(`bootstrap-${String(counter.value)}`, other);
			const view = reuseViewNameSchema.parse(
				`constrained-${String(counter.value)}`
			);
			await setView(
				[f.source, other].map(({ name }) => ({ kind: 'named', name })),
				view
			);
			const result = { ...f.result, cache: other };
			const publication =
				association === 'recorded'
					? await captureResult({ ...f, source: other, result })
					: undefined;
			const before = await lookupState();
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const authority = new PublicationManifestAuthority(instance.context);
				const original = authority.resolveExact(
					f.destination,
					f.grants,
					f.result
				);
				const constrained = authority.resolveExact(
					f.destination,
					f.grants,
					result
				);
				expect(constrained.cache.id).toBeGreaterThan(original.cache.id);
				await authority.requireServable(original);
				await authority.requireServable(constrained);
				const repository = new PublicationManifestRepository(instance.context);
				const sourceSelector = {
					view,
					expectedRevision: before.views.find((row) => row.name === view)
						?.revision
				};
				expect(
					await repository.lookup(f.destination, f.grants, {
						source: { selector: { view } },
						results: [{ storePath: f.result.storePath }]
					})
				).toStrictEqual({
					entries: [{ kind: 'missing', result: f.result }],
					sourceSelector
				});
				expect(
					await repository.lookup(f.destination, f.grants, {
						source: {
							cache: other,
							selector: { view },
							expectedCacheGeneration: result.cacheGeneration
						},
						results: [
							{
								storePath: result.storePath,
								narHash: result.narHash,
								generation: result.generation
							}
						]
					})
				).toStrictEqual({
					entries: [
						publication === undefined
							? { kind: 'missing', result }
							: { kind: 'recorded', publication, complete: true }
					],
					sourceSelector
				});
			});
			expect(await lookupState()).toStrictEqual(before);
		}
	);
	it.each(['absent', 'ambiguous'] as const)(
		'preserves combined private source authority and identity refusals for an %s target',
		async (availability) => {
			const f = await fixture('private');
			const other = namedCache(`private-conflict-${String(counter.value)}`);
			await committedPath('private-conflicting-nar', other, {
				access: 'private'
			});
			const view = reuseViewNameSchema.parse(
				`private-constraint-${String(counter.value)}`
			);
			await setView(
				[f.source, other].map(({ name }) => ({ kind: 'named', name })),
				view,
				'private'
			);
			const grants = authorizationDetailsSchema.parse([
				...f.grants,
				{ type: 'cupboard_view', view, actions: ['view:content-read'] }
			]);
			const storePath =
				availability === 'ambiguous'
					? f.result.storePath
					: storePathSchema.parse(
							'/nix/store/00000000000000000000000000000000-absent'
						);
			const before = await lookupState();
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const repository = new PublicationManifestRepository(instance.context);
				const source = { cache: f.source, selector: { view } };
				const results = [{ storePath }];
				expect(
					await repository.lookup(f.destination, grants, { source, results })
				).toStrictEqual({
					entries: [{ kind: 'unavailable', storePath }],
					sourceSelector: {
						view,
						expectedRevision: before.views.find((row) => row.name === view)
							?.revision
					}
				});
				await expect(
					repository.lookup(f.destination, f.grants, { source, results })
				).rejects.toMatchObject({ code: 'FORBIDDEN' });
				await expect(
					repository.lookup(f.destination, [], { source, results })
				).rejects.toMatchObject({ code: 'FORBIDDEN' });
				await expect(
					repository.lookup(f.destination, grants, {
						source: {
							...source,
							expectedCacheGeneration: cacheGenerationSchema.parse(
								f.result.cacheGeneration + 1
							)
						},
						results
					})
				).rejects.toMatchObject({ code: 'PUBLICATION_GENERATION_CONFLICT' });
				await expect(
					repository.lookup(f.destination, grants, {
						source,
						results: [{ storePath, narHash: f.result.narHash }]
					})
				).rejects.toMatchObject({ code: 'PUBLICATION_RESULT_CHANGED' });
			});
			await setView([{ kind: 'named', name: other.name }], view, 'private');
			await expect(
				runInDurableObject(fixtureWorkerServer(), (instance) =>
					new PublicationManifestRepository(instance.context).lookup(
						f.destination,
						grants,
						{
							source: { cache: f.source, selector: { view } },
							results: [{ storePath }]
						}
					)
				)
			).rejects.toMatchObject({ code: 'PUBLICATION_SCOPE_CHANGED' });
		}
	);
	it.each(
		(['unbacked', 'newly-backed', 'original-unbacked'] as const).flatMap(
			(backing) =>
				(
					[
						'view-only',
						'combined-original',
						...(backing === 'original-unbacked'
							? []
							: (['combined-sibling'] as const))
					] as const
				).map((sourceConstraint) => ({ backing, sourceConstraint }))
		)
	)(
		'excludes an unarbitrated disagreeing lower-ID sibling when $backing for $sourceConstraint',
		async ({ backing, sourceConstraint }) => {
			const other = namedCache(`unarbitrated-${String(counter.value + 1)}`);
			const token = await initialiseViaWorker();
			await putWorkerTestCache(token, other, 'public');
			const f = await fixture();
			const { metadata, nar } = await verifiablePath(
				`bootstrap-${String(counter.value)}`,
				{ references: [] }
			);
			await pushPathToTenant(fixtureTenant, token, metadata, nar, other);
			const view = reuseViewNameSchema.parse(
				`unarbitrated-${String(counter.value)}`
			);
			await setView(
				[other, f.source].map(({ name }) => ({ kind: 'named', name })),
				view
			);
			const accepted = await lookupState();
			const source = {
				selector: { view },
				...(sourceConstraint !== 'view-only' && {
					cache: sourceConstraint === 'combined-original' ? f.source : other
				})
			};
			const entries = [
				sourceConstraint === 'combined-sibling'
					? { kind: 'unavailable', storePath: f.result.storePath }
					: { kind: 'missing', result: f.result }
			];
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const authority = new PublicationManifestAuthority(instance.context);
				const sibling = authority.resolveTarget(
					f.destination,
					f.grants,
					other,
					{ storePath: f.result.storePath }
				);
				const original = authority.resolveExact(
					f.destination,
					f.grants,
					f.result
				);
				expect(sibling.cache.id).toBeLessThan(original.cache.id);
				expect(sibling.result).toStrictEqual({ ...f.result, cache: other });
				await authority.requireServable(sibling);
				await authority.requireServable(original);
				const rows = [sibling, original].map(({ cache }) =>
					accepted.versions.find((row) => row.cacheId === cache.id)
				);
				expect(rows.map((row) => row?.referencesJson)).toStrictEqual([
					'[]',
					JSON.stringify([StorePath.basename(f.result.storePath)])
				]);
				const edge = accepted.edges.find((row) => row.cacheName === other.name);
				if (edge === undefined) {
					throw new Error('Missing accepted sibling edge');
				}
				await instance.context.d1
					.delete(d1Schema.blobReference)
					.where(eq(d1Schema.blobReference.cacheName, other.name))
					.run();
				const baseline = {
					entries,
					sourceSelector: {
						view,
						expectedRevision: accepted.views.find((row) => row.name === view)
							?.revision
					}
				};
				expect(
					await new PublicationManifestRepository(instance.context).lookup(
						f.destination,
						f.grants,
						{
							source,
							results: [{ storePath: f.result.storePath }]
						}
					)
				).toStrictEqual(baseline);
			});
			await runInDurableObject(
				fixtureWorkerServer(),
				async (instance, state) => {
					const paused = Promise.withResolvers<undefined>();
					const resume = Promise.withResolvers<undefined>();
					let edgeQueries = 0;
					const edgeStatements = new WeakSet<D1PreparedStatement>();
					const binding = new Proxy(instance.context.env.CUPBOARD_DB, {
						get(target, field) {
							if (field === 'prepare') {
								return (query: string) => {
									const statement = target.prepare(query);
									if (!query.includes('requested_versions')) {
										return statement;
									}
									return new Proxy(statement, {
										get(source, property) {
											if (property === 'bind') {
												return (...values: unknown[]) => {
													const bound = source.bind(...values);
													edgeStatements.add(bound);
													return bound;
												};
											}
											const value: unknown = Reflect.get(
												source,
												property,
												source
											);
											return typeof value === 'function'
												? (...arguments_: unknown[]): unknown =>
														Reflect.apply(value, source, arguments_)
												: value;
										}
									});
								};
							}
							if (field === 'batch') {
								return async (statements: D1PreparedStatement[]) => {
									const reply = await target.batch(statements);
									if (
										statements.some((statement) =>
											edgeStatements.has(statement)
										)
									) {
										edgeQueries += 1;
										if (edgeQueries === 1) {
											expect(reply[0]?.results).toStrictEqual([
												{
													cache_kind: f.source.kind,
													cache_name: f.source.name,
													store_path_hash: StorePath.hash(f.result.storePath),
													generation: f.result.generation,
													nar_hash: f.result.narHash
												}
											]);
											paused.resolve(undefined);
											await resume.promise;
										}
									}
									return reply;
								};
							}
							const value: unknown = Reflect.get(target, field, target);
							return typeof value === 'function'
								? (...arguments_: unknown[]): unknown =>
										Reflect.apply(value, target, arguments_)
								: value;
						}
					});
					const context = new ServerContext(state, {
						...instance.context.env,
						CUPBOARD_DB: binding
					});
					const lookup = (async () => {
						try {
							return {
								response: await new PublicationManifestRepository(
									context
								).lookup(f.destination, f.grants, {
									source,
									results: [{ storePath: f.result.storePath }]
								})
							};
						} catch (error) {
							if (!(error instanceof ORPCError)) {
								throw error;
							}
							return { code: String(error.code) };
						}
					})();
					try {
						await Promise.race([
							paused.promise,
							(async () => {
								await lookup;
								throw new Error('Lookup settled before arbitration edge pause');
							})()
						]);
						expect(edgeQueries).toBe(1);
						if (backing !== 'unbacked') {
							const edge = accepted.edges.find(
								(row) => row.cacheName === other.name
							);
							if (edge === undefined) {
								throw new Error('Missing accepted sibling edge');
							}
							await instance.context.d1
								.insert(d1Schema.blobReference)
								.values(edge)
								.run();
						}
						if (backing === 'original-unbacked') {
							await instance.context.d1
								.delete(d1Schema.blobReference)
								.where(eq(d1Schema.blobReference.cacheName, f.source.name))
								.run();
						}
						const before = await lookupState();
						resume.resolve(undefined);
						expect(await lookup).toStrictEqual(
							backing === 'original-unbacked'
								? { code: 'PUBLICATION_RESULT_CHANGED' }
								: {
										response: {
											entries,
											sourceSelector: {
												view,
												expectedRevision: before.views.find(
													(row) => row.name === view
												)?.revision
											}
										}
									}
						);
						expect(edgeQueries).toBe(
							sourceConstraint === 'combined-sibling' ? 1 : 2
						);
						expect(await lookupState()).toStrictEqual(before);
						if (backing === 'newly-backed') {
							expect(
								await new PublicationManifestRepository(
									instance.context
								).lookup(f.destination, f.grants, {
									source,
									results: [{ storePath: f.result.storePath }]
								})
							).toStrictEqual({
								entries: [
									{ kind: 'unavailable', storePath: f.result.storePath }
								],
								sourceSelector: {
									view,
									expectedRevision: before.views.find(
										(row) => row.name === view
									)?.revision
								}
							});
						}
					} finally {
						resume.resolve(undefined);
						await lookup;
					}
				}
			);
		}
	);
	it('retains only usable semantic evidence and serves through malformed discarded sibling churn', async () =>
		withoutAlarmArming(async () => {
			const f = await fixture();
			const other = namedCache(`identity-agreeing-${String(counter.value)}`);
			const discarded = namedCache(
				`identity-discarded-${String(counter.value)}`
			);
			await committedPath(`bootstrap-${String(counter.value)}`, other);
			await insertUnbackedRow(
				discarded,
				StorePath.hash(f.result.storePath),
				f.result.narHash
			);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(discarded);
				instance.context.db
					.update(schema.narInfos)
					.set({ referencesJson: '{invalid' })
					.where(eq(schema.narInfos.cacheId, cache.id))
					.run();
			});
			const view = reuseViewNameSchema.parse(
				`identity-${String(counter.value)}`
			);
			await setView(
				[f.source, other, discarded].map((cache) => ({
					kind: 'named',
					name: cache.name
				})),
				view
			);
			const before = await lookupState();
			let mutated: Awaited<ReturnType<typeof lookupState>> | undefined;
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const service = new ReuseViewLookupService(instance.context);
				const lookupOriginal = service.lookupWithArbitration.bind(service);
				let arbitration: ReuseViewArbitrationSnapshot | undefined;
				const lookupSpy = vi
					.spyOn(ReuseViewLookupService.prototype, 'lookupWithArbitration')
					.mockImplementation(async (...arguments_) => {
						const result = await lookupOriginal(...arguments_);
						arbitration =
							result?.kind === 'ready' ? result.arbitration : undefined;
						const discardedCache =
							instance.context.cacheRepository.require(discarded);
						instance.context.db
							.delete(schema.narInfos)
							.where(eq(schema.narInfos.cacheId, discardedCache.id))
							.run();
						mutated = await lookupState();
						return result;
					});
				try {
					const response = await new PublicationManifestRepository(
						instance.context
					).lookup(f.destination, f.grants, {
						source: { selector: { view } },
						results: [{ storePath: f.result.storePath }]
					});
					const expectedRevision = before.views.find(
						(row) => row.name === view
					)?.revision;
					expect(response).toStrictEqual({
						entries: [{ kind: 'missing', result: f.result }],
						sourceSelector: { view, expectedRevision }
					});
					const usableIds = new Set(
						[f.source, other].map(
							(scope) => instance.context.cacheRepository.require(scope).id
						)
					);
					const expectedCandidates = [];
					for (const row of before.versions) {
						if (!usableIds.has(row.cacheId)) {
							continue;
						}
						const references = storedReferencesSchema
							.parse(JSON.parse(row.referencesJson))
							.toSorted(byCodeUnit);
						expectedCandidates.push({
							cacheId: row.cacheId,
							storePathHash: row.storePathHash,
							generation: row.generation,
							narHash: row.narHash,
							semanticDigest: await sha256Hex(
								JSON.stringify([
									row.storePath,
									row.narHash,
									row.narSize,
									references,
									row.deriver,
									row.ca
								])
							)
						});
					}
					expect(arbitration).toStrictEqual({
						view,
						revision: expectedRevision,
						access: 'public',
						candidates: expectedCandidates
					});
					if (arbitration === undefined) {
						throw new Error('Missing arbitration evidence');
					}
					const evidence = arbitration;
					await instance.context.criticalSection(() =>
						withOperationCost(
							'arbitration-revalidation-test',
							async () => {
								expect(await service.revalidateArbitration(evidence)).toBe(
									true
								);
							},
							(cost) => {
								expect(cost).toStrictEqual({
									rowsRead: 5,
									rowsWritten: 0,
									d1Calls: 0,
									d1RowsRead: 0,
									d1RowsWritten: 0,
									d1CallsWithoutRows: 0,
									r2Head: 0,
									r2Get: 0,
									r2Put: 0,
									r2Delete: 0,
									r2List: 0
								});
							}
						)
					);
				} finally {
					lookupSpy.mockRestore();
				}
			});
			const discardedId = before.caches.find(
				(cache) => cache.name === discarded.name
			)?.id;
			expect(mutated?.versions).toStrictEqual(
				before.versions.filter((row) => row.cacheId !== discardedId)
			);
			expect(mutated?.availabilityIntents).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						cacheId: discardedId,
						kind: 'local',
						remotePending: false
					})
				])
			);
			if (mutated === undefined) {
				throw new Error('Missing state after the discarded candidate deletion');
			}
			const unchangedByDeletion = (
				state: Awaited<ReturnType<typeof lookupState>>
			) => {
				const {
					versions: _versions,
					availabilityClock: _clock,
					availabilityRevisions: _revisions,
					availabilityIntents: _intents,
					...unchanged
				} = state;
				return unchanged;
			};
			expect(unchangedByDeletion(mutated)).toStrictEqual(
				unchangedByDeletion(before)
			);
			expect(await lookupState()).toStrictEqual(mutated);
		}, fixtureWorkerServer()));

	it.each(
		(['initial-probe', 'repository-edge', 'later-probe'] as const).flatMap(
			(gap) =>
				(
					[
						'full-path',
						'nar-size',
						'references',
						'deriver',
						'ca',
						'generation',
						'references-order',
						'malformed-references',
						'access'
					] as const
				)
					.filter((change) =>
						change === 'access'
							? gap === 'repository-edge'
							: change === 'generation'
								? gap !== 'repository-edge'
								: change !== 'full-path' || gap !== 'later-probe'
					)
					.flatMap((change) =>
						(['view-only', 'combined'] as const).map((sourceConstraint) => ({
							gap,
							change,
							sourceConstraint
						}))
					)
		)
	)(
		'preserves the whole outcome for usable sibling $change during $gap for $sourceConstraint',
		async ({ gap, change, sourceConstraint }) =>
			withoutAlarmArming(async () => {
				const references =
					change === 'references-order'
						? [
								'00000000000000000000000000000000-reference',
								'11111111111111111111111111111111-first'
							]
						: undefined;
				const f = await fixture('public', references);
				const other = namedCache(`semantic-sibling-${String(counter.value)}`);
				await committedPath(`bootstrap-${String(counter.value)}`, other, {
					references
				});
				const view = reuseViewNameSchema.parse(
					`semantic-${String(counter.value)}`
				);
				await setView(
					[f.source, other].map(({ name }) => ({ kind: 'named', name })),
					view
				);
				const publication = await captureResult(f);
				const later =
					gap === 'later-probe'
						? await committedPath(
								`semantic-later-${String(counter.value)}`,
								f.source,
								{
									storePathHash: '00000000000000000000000000000001',
									name: 'later'
								}
							)
						: undefined;
				if (change === 'generation' && later !== undefined) {
					await committedPath(
						`semantic-later-${String(counter.value)}`,
						other,
						{
							storePathHash: StorePath.hash(later.storePath),
							name: 'later'
						}
					);
				}
				const before = await lookupState();
				const expected = {
					entries: [{ kind: 'recorded', publication, complete: true }],
					sourceSelector: {
						view,
						expectedRevision: before.views.find((row) => row.name === view)
							?.revision
					}
				};
				await runInDurableObject(
					fixtureWorkerServer(),
					async (instance, state) => {
						expect(
							await new PublicationManifestRepository(instance.context).lookup(
								f.destination,
								f.grants,
								{
									source: {
										selector: { view },
										...(sourceConstraint === 'combined' && { cache: f.source })
									},
									results: [{ storePath: f.result.storePath }]
								}
							)
						).toStrictEqual(expected);
						const paused = Promise.withResolvers<undefined>();
						const resume = Promise.withResolvers<undefined>();
						let edgeQueries = 0;
						let heads = 0;
						const edgeStatements = new WeakSet<D1PreparedStatement>();
						const binding = new Proxy(instance.context.env.CUPBOARD_DB, {
							get(target, field) {
								if (field === 'prepare') {
									return (query: string) => {
										const statement = target.prepare(query);
										if (!query.includes('requested_versions')) {
											return statement;
										}
										return new Proxy(statement, {
											get(source, property) {
												if (property === 'bind') {
													return (...values: unknown[]) => {
														const bound = source.bind(...values);
														edgeStatements.add(bound);
														return bound;
													};
												}
												const value: unknown = Reflect.get(
													source,
													property,
													source
												);
												return typeof value === 'function'
													? (...arguments_: unknown[]): unknown =>
															Reflect.apply(value, source, arguments_)
													: value;
											}
										});
									};
								}
								if (field === 'batch') {
									return async (statements: D1PreparedStatement[]) => {
										const isEdge = statements.some((statement) =>
											edgeStatements.has(statement)
										);
										const reply = await target.batch(statements);
										if (isEdge) {
											edgeQueries += 1;
										}
										if (
											gap === 'repository-edge' &&
											isEdge &&
											edgeQueries === 2
										) {
											paused.resolve(undefined);
											await resume.promise;
										}
										return reply;
									};
								}
								const value: unknown = Reflect.get(target, field, target);
								return typeof value === 'function'
									? (...arguments_: unknown[]): unknown =>
											Reflect.apply(value, target, arguments_)
									: value;
							}
						});
						const blobs = new Proxy(instance.context.env.BLOBS, {
							get(target, field) {
								if (field === 'head') {
									return async (key: string) => {
										const reply = await target.head(key);
										heads += 1;
										if (
											(gap === 'initial-probe' && heads === 1) ||
											(gap === 'later-probe' && heads === 2)
										) {
											paused.resolve(undefined);
											await resume.promise;
										}
										return reply;
									};
								}
								const value: unknown = Reflect.get(target, field, target);
								return typeof value === 'function'
									? (...arguments_: unknown[]): unknown =>
											Reflect.apply(value, target, arguments_)
									: value;
							}
						});
						const context = new ServerContext(state, {
							...instance.context.env,
							CUPBOARD_DB: binding,
							BLOBS: blobs
						});
						const lookup = (async () => {
							try {
								const response = await new PublicationManifestRepository(
									context
								).lookup(f.destination, f.grants, {
									source: {
										selector: { view },
										...(sourceConstraint === 'combined' && { cache: f.source })
									},
									results: [
										{ storePath: f.result.storePath },
										...(later === undefined
											? []
											: [{ storePath: storePathSchema.parse(later.storePath) }])
									]
								});
								return { response };
							} catch (error) {
								if (error instanceof StoredReferencesInvalidError) {
									return { fault: 'stored-references-invalid' };
								}
								if (!(error instanceof ORPCError)) {
									throw error;
								}
								return { code: String(error.code) };
							}
						})();
						try {
							await Promise.race([
								paused.promise,
								(async () => {
									await lookup;
									throw new Error('Lookup settled before provider pause');
								})()
							]);
							expect({ heads, edgeQueries }).toStrictEqual({
								heads: gap === 'later-probe' ? 2 : 1,
								edgeQueries:
									gap === 'initial-probe'
										? 1
										: gap === 'repository-edge'
											? 2
											: 3
							});
							const cache = instance.context.cacheRepository.require(other);
							const original = before.versions.find(
								(row) =>
									row.cacheId === cache.id &&
									row.storePath ===
										(change === 'generation' && later !== undefined
											? later.storePath
											: f.result.storePath)
							);
							if (original === undefined) {
								throw new Error('Missing agreeing sibling');
							}
							if (change === 'access') {
								instance.context.db
									.update(schema.cacheIdentities)
									.set({ access: 'private' })
									.where(eq(schema.cacheIdentities.id, cache.id))
									.run();
							} else if (change === 'generation') {
								await removeSourcePath({
									...f,
									source: other,
									result: { ...f.result, storePath: original.storePath }
								});
								if (later === undefined) {
									await committedPath(
										`bootstrap-${String(counter.value)}`,
										other
									);
								} else {
									await committedPath(
										`semantic-later-${String(counter.value)}`,
										other,
										{ storePathHash: original.storePathHash, name: 'later' }
									);
								}
							} else {
								const patch =
									change === 'full-path'
										? {
												storePath: storePathSchema.parse(
													`${f.result.storePath}-renamed`
												)
											}
										: change === 'nar-size'
											? { narSize: original.narSize + 1 }
											: change === 'references'
												? {
														referencesJson: JSON.stringify([
															'00000000000000000000000000000000-reference'
														])
													}
												: change === 'deriver'
													? {
															deriver:
																'00000000000000000000000000000000-deriver.drv'
														}
													: change === 'ca'
														? { ca: 'fixed:r:sha256:changed' }
														: {
																referencesJson:
																	change === 'malformed-references'
																		? '{invalid'
																		: JSON.stringify(
																				storedReferencesSchema
																					.parse(
																						JSON.parse(original.referencesJson)
																					)
																					.toReversed()
																			)
															};
								instance.context.db
									.update(schema.narInfos)
									.set(patch)
									.where(eq(schema.narInfos.cacheId, cache.id))
									.run();
								const patched = await lookupState();
								expect(patched.versions).toStrictEqual(
									before.versions.map((row) =>
										row.cacheId === cache.id ? { ...row, ...patch } : row
									)
								);
							}
							const mutated = await lookupState();
							const authorityAndEffects = (value: typeof before) => {
								const {
									versions: _versions,
									availabilityClock: _clock,
									availabilityRevisions: _revisions,
									availabilityIntents: _intents,
									grace: _grace,
									edges: _edges,
									...unchanged
								} = value;
								return unchanged;
							};
							expect(
								authorityAndEffects(
									change === 'access'
										? { ...mutated, caches: before.caches }
										: mutated
								)
							).toStrictEqual(authorityAndEffects(before));
							if (change === 'access') {
								expect(mutated.caches).toStrictEqual(
									before.caches.map((row) =>
										row.id === cache.id ? { ...row, access: 'private' } : row
									)
								);
								expect(mutated.versions).toStrictEqual(before.versions);
							} else if (change === 'generation') {
								const current = mutated.versions.find(
									(row) =>
										row.cacheId === cache.id &&
										row.storePathHash === original.storePathHash
								);
								expect(current?.generation).toBeGreaterThan(
									original.generation
								);
								expect(current?.storePath).toBe(original.storePath);
								expect(current?.narHash).toBe(original.narHash);
							}
							expect(mutated.edges).toStrictEqual(
								before.edges.map((edge) =>
									change === 'generation' &&
									edge.cacheName === other.name &&
									edge.storePathHash === original.storePathHash
										? {
												...edge,
												generation: mutated.versions.find(
													(row) =>
														row.cacheId === cache.id &&
														row.storePathHash === original.storePathHash
												)?.generation
											}
										: edge
								)
							);
							resume.resolve(undefined);
							expect(await lookup).toStrictEqual(
								change === 'references-order'
									? {
											response: {
												...expected,
												entries: [
													...expected.entries,
													...(later === undefined
														? []
														: [
																{
																	kind: 'missing',
																	result: publicationResultIdentitySchema.parse(
																		{
																			...f.result,
																			storePath: later.storePath,
																			narHash: later.narHash
																		}
																	)
																}
															])
												]
											}
										}
									: change === 'malformed-references'
										? { fault: 'stored-references-invalid' }
										: { code: 'PUBLICATION_RESULT_CHANGED' }
							);
							expect({ heads, edgeQueries }).toStrictEqual({
								heads:
									gap === 'later-probe' ? (change === 'generation' ? 2 : 3) : 1,
								edgeQueries:
									gap === 'initial-probe' && change !== 'references-order'
										? 1
										: gap === 'later-probe'
											? change === 'generation'
												? 3
												: 4
											: 2
							});
							expect(await lookupState()).toStrictEqual(mutated);
						} finally {
							resume.resolve(undefined);
							await lookup;
						}
					}
				);
			})
	);

	it.each(
		[
			'selected-edge',
			'non-selected-edge',
			'non-selected-servability',
			'non-selected-later-target'
		].flatMap((gap) =>
			(['different-nar', 'same-nar', 'recreated-cache'] as const).flatMap(
				(change) =>
					(['view-only', 'combined'] as const).map((sourceConstraint) => ({
						gap,
						change,
						sourceConstraint
					}))
			)
		)
	)(
		'rejects $change replacement at $gap without losing arbitration evidence for $sourceConstraint',
		async ({ gap, change, sourceConstraint }) => {
			const f = await fixture();
			const seed = `bootstrap-${String(counter.value)}`;
			const other = namedCache(`bootstrap-agreeing-${String(counter.value)}`);
			await committedPath(seed, other);
			const view = reuseViewNameSchema.parse(`pin-${String(counter.value)}`);
			await setView(
				[
					{ kind: 'named', name: f.source.name },
					{ kind: 'named', name: other.name }
				],
				view
			);

			const publication =
				gap === 'non-selected-edge' ? await captureResult(f) : undefined;
			const later =
				gap === 'non-selected-later-target'
					? await committedPath(`${seed}-later`, f.source, {
							storePathHash: '00000000000000000000000000000001',
							name: 'later'
						})
					: undefined;
			const changedCache = gap === 'selected-edge' ? f.source : other;
			const unchangedCache = gap === 'selected-edge' ? other : f.source;
			const baseline = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					new PublicationManifestRepository(instance.context).lookup(
						f.destination,
						f.grants,
						{
							source: {
								selector: { view },
								...(sourceConstraint === 'combined' && { cache: f.source })
							},
							results: [{ storePath: f.result.storePath }]
						}
					)
			);
			const before = await lookupState();
			expect(baseline).toStrictEqual({
				entries: [
					publication === undefined
						? { kind: 'missing', result: f.result }
						: { kind: 'recorded', publication, complete: true }
				],
				sourceSelector: {
					view,
					expectedRevision: before.views.find((row) => row.name === view)
						?.revision
				}
			});
			expect(
				before.caches.some((cache) => cache.name === f.destination.name)
			).toBe(false);
			const sourceCaches = before.caches.filter(
				(cache) =>
					cache.name === changedCache.name || cache.name === unchangedCache.name
			);
			expect(
				before.versions
					.filter(
						(row) =>
							sourceCaches.some((cache) => cache.id === row.cacheId) &&
							row.storePath === f.result.storePath
					)
					.map((row) => row.narHash)
			).toStrictEqual([f.result.narHash, f.result.narHash]);
			expect(
				before.edges.filter(
					(edge) =>
						(edge.cacheName === changedCache.name ||
							edge.cacheName === unchangedCache.name) &&
						edge.storePathHash === StorePath.hash(f.result.storePath)
				)
			).toHaveLength(2);
			for (const cache of sourceCaches) {
				expect(
					before.edges
						.filter(
							(edge) =>
								edge.cacheName === cache.name &&
								edge.storePathHash === StorePath.hash(f.result.storePath)
						)
						.map((edge) => ({
							storePathHash: edge.storePathHash,
							generation: edge.generation,
							narHash: edge.narHash,
							cacheGeneration: edge.cacheGeneration
						}))
				).toStrictEqual([
					{
						storePathHash: StorePath.hash(f.result.storePath),
						generation: f.result.generation,
						narHash: f.result.narHash,
						cacheGeneration: f.result.cacheGeneration
					}
				]);
			}
			expect(before.publications).toHaveLength(
				publication === undefined ? 0 : 1
			);
			expect(before.members).toHaveLength(publication === undefined ? 0 : 1);
			expect(before.manifests).toHaveLength(publication === undefined ? 0 : 1);
			expect(before.receipts).toStrictEqual([]);
			expect(before.roots).toStrictEqual([]);
			expect(before.targets).toStrictEqual([]);
			await runInDurableObject(
				fixtureWorkerServer(),
				async (instance, state) => {
					const paused = Promise.withResolvers<undefined>();
					const resume = Promise.withResolvers<undefined>();
					let edgeQueries = 0;
					const edgeStatements = new WeakSet<D1PreparedStatement>();
					const binding = new Proxy(instance.context.env.CUPBOARD_DB, {
						get(target, field) {
							if (field === 'prepare') {
								return (query: string) => {
									const statement = target.prepare(query);
									if (!query.includes('requested_versions')) {
										return statement;
									}
									edgeStatements.add(statement);
									return new Proxy(statement, {
										get(source, property) {
											if (property === 'bind') {
												return (...values: unknown[]) => {
													const bound = source.bind(...values);
													edgeStatements.add(bound);
													return bound;
												};
											}
											const value: unknown = Reflect.get(
												source,
												property,
												source
											);
											return typeof value === 'function'
												? (...arguments_: unknown[]): unknown =>
														Reflect.apply(value, source, arguments_)
												: value;
										}
									});
								};
							}
							if (field === 'batch') {
								return async (statements: D1PreparedStatement[]) => {
									const isEdgeQuery = statements.some((statement) =>
										edgeStatements.has(statement)
									);
									const response = await target.batch(statements);
									if (
										isEdgeQuery &&
										++edgeQueries === 2 &&
										(gap === 'selected-edge' || gap === 'non-selected-edge')
									) {
										// The first edge query belongs to backed arbitration. This is
										// the repository's subsequent query, with its old reply in hand.
										expect(response[0]?.results).toHaveLength(2);
										paused.resolve(undefined);
										await resume.promise;
									}
									return response;
								};
							}
							const value: unknown = Reflect.get(target, field, target);
							return typeof value === 'function'
								? (...arguments_: unknown[]): unknown =>
										Reflect.apply(value, target, arguments_)
								: value;
						}
					});
					const context = new ServerContext(state, {
						...instance.context.env,
						CUPBOARD_DB: binding
					});
					const authority = new PublicationManifestAuthority(context);
					const isServableOriginal = authority.isServable.bind(authority);
					const isServableSpy = vi
						.spyOn(PublicationManifestAuthority.prototype, 'isServable')
						.mockImplementation(async (snapshot) => {
							const isAccepted = await isServableOriginal(snapshot);
							if (
								(gap === 'non-selected-servability' &&
									snapshot.result.storePath === f.result.storePath) ||
								(gap === 'non-selected-later-target' &&
									snapshot.result.storePath === later?.storePath)
							) {
								paused.resolve(undefined);
								await resume.promise;
							}
							return isAccepted;
						});
					const lookup = (async () => {
						try {
							const response = await new PublicationManifestRepository(
								context
							).lookup(f.destination, f.grants, {
								source: {
									selector: { view },
									...(sourceConstraint === 'combined' && { cache: f.source })
								},
								results: [
									{ storePath: f.result.storePath },
									...(later === undefined
										? []
										: [{ storePath: storePathSchema.parse(later.storePath) }])
								]
							});
							return { response };
						} catch (error) {
							if (!(error instanceof ORPCError)) {
								throw error;
							}
							return { code: String(error.code) };
						}
					})();
					try {
						await Promise.race([
							paused.promise,
							(async () => {
								await lookup;
								throw new Error(
									'Lookup settled before the post-arbitration edge pause'
								);
							})()
						]);
						expect(edgeQueries).toBe(later === undefined ? 2 : 4);
						if (change === 'recreated-cache') {
							const response = await authorisedWorkerFetch(
								`/caches/${changedCache.name}?force=true`,
								await initialiseViaWorker(),
								{ method: 'DELETE' }
							);
							expect(response.status).toBe(200);
						} else {
							await removeSourcePath({ ...f, source: changedCache });
						}
						await committedPath(
							change === 'different-nar' ? `${seed}-replacement` : seed,
							changedCache
						);
						const replaced = await lookupState();
						const originalCache = before.caches.find(
							(cache) => cache.name === changedCache.name
						);
						const currentCache = replaced.caches.find(
							(cache) =>
								cache.name === changedCache.name && cache.deletedAt === null
						);
						expect(originalCache).toBeDefined();
						expect(currentCache).toBeDefined();
						const current = replaced.versions.find(
							(row) => row.cacheId === currentCache?.id
						);
						expect(current?.storePath).toBe(f.result.storePath);
						expect(current?.narHash === f.result.narHash).toBe(
							change !== 'different-nar'
						);
						if (change === 'recreated-cache') {
							expect(currentCache?.id).not.toBe(originalCache?.id);
							expect(currentCache?.generation).toBeGreaterThan(
								f.result.cacheGeneration
							);
						} else {
							expect(currentCache).toStrictEqual(originalCache);
							expect(current?.generation).toBeGreaterThan(f.result.generation);
						}
						const otherId = before.caches.find(
							(cache) => cache.name === unchangedCache.name
						)?.id;
						expect(
							replaced.versions.find((row) => row.cacheId === otherId)
						).toStrictEqual(
							before.versions.find((row) => row.cacheId === otherId)
						);
						expect(
							replaced.edges.filter(
								(edge) => edge.cacheName === unchangedCache.name
							)
						).toStrictEqual(
							before.edges.filter(
								(edge) => edge.cacheName === unchangedCache.name
							)
						);
						expect(
							replaced.edges
								.filter((edge) => edge.cacheName === changedCache.name)
								.map((edge) => ({
									storePathHash: edge.storePathHash,
									generation: edge.generation,
									narHash: edge.narHash,
									cacheGeneration: edge.cacheGeneration
								}))
						).toStrictEqual([
							{
								storePathHash: current?.storePathHash,
								generation: current?.generation,
								narHash: current?.narHash,
								cacheGeneration: currentCache?.generation
							}
						]);
						expect(replaced.views).toStrictEqual(before.views);
						expect(replaced.selectors).toStrictEqual(before.selectors);
						resume.resolve(undefined);
						expect(await lookup).toStrictEqual({
							code:
								gap === 'non-selected-servability' ||
								gap === 'non-selected-later-target'
									? 'SERVICE_UNAVAILABLE'
									: change === 'recreated-cache' && gap === 'selected-edge'
										? 'PUBLICATION_GENERATION_CONFLICT'
										: 'PUBLICATION_RESULT_CHANGED'
						});
						expect(await lookupState()).toStrictEqual(replaced);
					} finally {
						isServableSpy.mockRestore();
						resume.resolve(undefined);
						await lookup;
					}
				}
			);
		}
	);
	it.each(['nar-hash', 'generation', 'both'] as const)(
		"preserves the caller's %s constraint when pinning the arbitrated row",
		async (constraint) => {
			const f = await fixture();
			await removeSourcePath(f);
			await committedPath(
				constraint === 'generation'
					? `bootstrap-${String(counter.value)}`
					: `constraint-replacement-${String(counter.value)}`,
				f.source
			);
			const view = reuseViewNameSchema.parse(
				`constraint-${String(counter.value)}`
			);
			await setView([{ kind: 'named', name: f.source.name }], view);
			const before = await lookupState();
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const repository = new PublicationManifestRepository(instance.context);
				const response = await repository.lookup(f.destination, f.grants, {
					source: { selector: { view } },
					results: [{ storePath: f.result.storePath }]
				});
				const current = new PublicationManifestAuthority(
					instance.context
				).resolveTarget(f.destination, f.grants, f.source, {
					storePath: f.result.storePath
				});
				expect(response).toStrictEqual({
					entries: [{ kind: 'missing', result: current.result }],
					sourceSelector: {
						view,
						expectedRevision: before.views.find((row) => row.name === view)
							?.revision
					}
				});
				expect(current.result.generation).toBeGreaterThan(f.result.generation);
				expect(
					await repository.lookup(f.destination, f.grants, {
						source: { selector: { view } },
						results: [
							{
								storePath: current.result.storePath,
								...(constraint !== 'generation' && {
									narHash: current.result.narHash
								}),
								...(constraint !== 'nar-hash' && {
									generation: current.result.generation
								})
							}
						]
					})
				).toStrictEqual(response);
				await expect(
					repository.lookup(f.destination, f.grants, {
						source: { selector: { view } },
						results: [
							{
								storePath: f.result.storePath,
								...(constraint !== 'generation' && {
									narHash: f.result.narHash
								}),
								...(constraint !== 'nar-hash' && {
									generation: f.result.generation
								})
							}
						]
					})
				).rejects.toMatchObject({ code: 'PUBLICATION_RESULT_CHANGED' });
			});
			expect(await lookupState()).toStrictEqual(before);
		}
	);
	it('does not swallow provider failures into unavailable or missing entries', async () => {
		const f = await fixture();
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const isServableSpy = vi
				.spyOn(PublicationManifestAuthority.prototype, 'isServable')
				.mockRejectedValue(new Error('provider failure'));
			try {
				await expect(
					new PublicationManifestRepository(instance.context).lookup(
						f.destination,
						f.grants,
						{
							source: { cache: f.source },
							results: [{ storePath: f.result.storePath }]
						}
					)
				).rejects.toThrow('provider failure');
			} finally {
				isServableSpy.mockRestore();
			}
		});
	});
});

describe('PublicationManifestRepository acceptance fences', () => {
	beforeEach(resetTestServer);
	it('reports a bare local reservation as unavailable, not an accepted missing association', async () => {
		const f = await fixture();
		const hash = storePathHashSchema.parse('00000000000000000000000000000000');
		const path = storePathSchema.parse(`/nix/store/${hash}-reservation`);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.source);
			const row = instance.context.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.cacheId, cache.id))
				.get();
			if (row === undefined) {
				throw new Error('Missing fixture');
			}
			instance.context.db
				.insert(schema.narInfos)
				.values({ ...row, storePathHash: hash, storePath: path })
				.run();
		});
		const response = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) =>
				new PublicationManifestRepository(instance.context).lookup(
					f.destination,
					f.grants,
					{
						source: { cache: f.source },
						results: [{ storePath: path }, { storePath: f.result.storePath }]
					}
				)
		);
		expect(response.entries).toStrictEqual([
			{ kind: 'unavailable', storePath: path },
			{ kind: 'missing', result: f.result }
		]);
	});
	it.each(['access', 'cache-generation', 'result-generation'] as const)(
		'rejects a %s change across the external acceptance probe',
		async (change) => {
			const f = await fixture();
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const authority = new PublicationManifestAuthority(instance.context);
				const isServableOriginal = authority.isServable.bind(authority);
				const isServableSpy = vi
					.spyOn(PublicationManifestAuthority.prototype, 'isServable')
					.mockImplementation(async (snapshot) => {
						const isAccepted = await isServableOriginal(snapshot);
						if (change === 'access') {
							instance.context.db
								.update(schema.cacheIdentities)
								.set({ access: 'private' })
								.where(eq(schema.cacheIdentities.id, snapshot.cache.id))
								.run();
						} else if (change === 'cache-generation') {
							instance.context.db
								.update(schema.cacheIdentities)
								.set({
									generation: cacheGenerationSchema.parse(
										snapshot.cache.generation + 1
									)
								})
								.where(eq(schema.cacheIdentities.id, snapshot.cache.id))
								.run();
						} else {
							instance.context.db
								.update(schema.narInfos)
								.set({
									generation: narInfoGenerationSchema.parse(
										snapshot.result.generation + 1
									)
								})
								.where(eq(schema.narInfos.cacheId, snapshot.cache.id))
								.run();
						}
						return isAccepted;
					});
				try {
					await expect(
						new PublicationManifestRepository(instance.context).lookup(
							f.destination,
							f.grants,
							{
								source: { cache: f.source },
								results: [{ storePath: f.result.storePath }]
							}
						)
					).rejects.toMatchObject({
						code:
							change === 'access'
								? 'PUBLICATION_SCOPE_CHANGED'
								: 'SERVICE_UNAVAILABLE'
					});
				} finally {
					isServableSpy.mockRestore();
				}
			});
		}
	);
});

describe('PublicationManifestRepository finalisation invariant', () => {
	beforeEach(resetTestServer);
	it.each([
		'missing-candidate',
		'changed-candidate',
		'restored-candidate',
		'extra-candidate',
		'missing-portable',
		'restored-portable'
	] as const)('refuses %s despite a finished cursor', async (mutation) => {
		const f = await fixture();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const database = instance.context.db;
			const cache = instance.context.cacheRepository.require(f.source);
			database.run(
				sql`INSERT INTO publication_manifest_operation(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,cursor,candidate_digest,expires_at) VALUES (${mutation},'request','ensure',${cache.id},${cache.generation},'{}','{}','build-selection',1,1,${mutation},'2099-01-01T00:00:00.000Z')`
			);
			database.run(
				sql`INSERT INTO publication_manifest(digest,version,member_count) VALUES (${mutation},1,1)`
			);
			const candidate = sql`INSERT INTO result_publication_member (cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation) VALUES (${cache.id},${cache.generation},'result',1,${mutation},'tool','/nix/store/tool-compiler','sha256:nar',1)`;
			const portable = sql`INSERT INTO publication_manifest_member VALUES (${mutation},0,'/nix/store/tool-compiler','tool','sha256:nar')`;
			database.run(candidate);
			database.run(portable);
			const repository = new PublicationManifestRepository(instance.context);
			database.transaction(() => {
				repository.assertMaterialisationComplete(mutation, mutation, 1);
			});
			if (mutation === 'changed-candidate') {
				database.run(
					sql`UPDATE result_publication_member SET member_generation=member_generation+1 WHERE materialisation_id=${mutation}`
				);
			} else if (mutation === 'extra-candidate') {
				database.run(
					sql`INSERT INTO result_publication_member (cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation) SELECT cache_id,cache_generation,result_hash,result_generation,materialisation_id,'extra','/nix/store/extra-path',member_nar_hash,member_generation FROM result_publication_member WHERE materialisation_id=${mutation}`
				);
			} else if (mutation.endsWith('candidate')) {
				database.run(
					sql`DELETE FROM result_publication_member WHERE materialisation_id=${mutation}`
				);
				if (mutation === 'restored-candidate') {
					database.run(candidate);
				}
			} else {
				database.run(
					sql`DELETE FROM publication_manifest_member WHERE digest=${mutation}`
				);
				if (mutation === 'restored-portable') {
					database.run(portable);
				}
			}
			expect(() => {
				database.transaction(() => {
					repository.assertMaterialisationComplete(mutation, mutation, 1);
				});
			}).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
			expect(
				database.select().from(schema.resultPublications).all()
			).toHaveLength(0);
		});
	});
});
