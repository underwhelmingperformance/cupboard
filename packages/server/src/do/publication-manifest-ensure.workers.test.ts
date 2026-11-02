import { rootLogger } from '@cupboard/logger';
import {
	narInfoGenerationSchema,
	nixSha256HashSchema,
	rootNameSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import {
	publicationCleanupMarginMs,
	publicationIdentity,
	publicationRecoveryMs
} from '@cupboard/protocol/publication';
import {
	createPublicationRequestId,
	publicationEnsureRequestSchema,
	publicationEnsureResponseSchema,
	publicationOperationIdSchema,
	publicationResultIdentitySchema
} from '@cupboard/protocol/publication-manifests';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadPathNegotiationSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { runMaintenanceBatch } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedWorkerFetch,
	fixtureWorkerServer,
	initialiseViaWorker,
	namedCache,
	pushPathToTenant,
	putWorkerTestCache,
	resetTestServer,
	restartTestServers,
	testControlEnv,
	testPushIdFor,
	verifiablePath,
	withoutAlarmArming
} from '../test-support.ts';

import type { ServerContext } from './context.ts';
import { GarbageCollectionInputs } from './garbage-collection-inputs.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import { PublicationManifestAuthority } from './publication-manifest-authority.ts';
import { PublicationManifestAvailabilityStore } from './publication-manifest-availability-store.ts';
import { PublicationManifestCaptureService } from './publication-manifest-capture.ts';
import { PublicationManifestCleanup } from './publication-manifest-cleanup.ts';
import { PublicationManifestEnsureService } from './publication-manifest-ensure.ts';
import { ProductionPublicationManifestPublisher } from './publication-manifest-production.ts';
import type { PublicationManifestPublisher } from './publication-manifest-publisher.ts';
import { PublicationManifestRepository } from './publication-manifest-repository.ts';
import { committedPath, setView } from './reuse-view-read.test-support.ts';
import { currentRowBudgetMeter, withRowBudget } from './row-budget.ts';

const sequence = { next: 0 };
async function fixture(
	options: {
		same?: boolean;
		absent?: boolean;
		private?: boolean;
		child?: boolean;
		narSeed?: string;
		graceSeconds?: number;
	} = {}
) {
	sequence.next += 1;
	const seed = `ensure-${String(sequence.next)}`;
	const narSeed = options.narSeed ?? seed;
	const source = namedCache(`${seed}-source`);
	const destination =
		options.same === true ? source : namedCache(`${seed}-destination`);
	if (options.graceSeconds !== undefined) {
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const configured = await authorisedWorkerFetch(
			`/caches/${destination.name}`,
			token,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: 'set-grace',
					graceSeconds: options.graceSeconds
				})
			}
		);
		expect(configured.status).toBe(200);
	}
	const fields = {
		storePathHash: '00000000000000000000000000000001',
		name: 'result'
	};
	const childFields = {
		storePathHash: '00000000000000000000000000000002',
		name: 'child'
	};
	await committedPath(narSeed, source, {
		...fields,
		access: options.private === true ? 'private' : 'public'
	});
	if (options.child === true) {
		await committedPath(`${narSeed}-child`, source, childFields);
	}
	if (options.same !== true && options.absent !== true) {
		await committedPath(narSeed, destination, fields);
		if (options.child === true) {
			await committedPath(`${narSeed}-child`, destination, childFields);
		}
	}
	const grants = authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			cache: destination,
			actions: ['upload:commit']
		},
		{
			type: 'cupboard_cache',
			cache: destination,
			root: 'run/',
			actions: ['root:attach']
		}
	]);
	const publication = await runInDurableObject(
		fixtureWorkerServer(),
		async (instance) => {
			const cache = instance.context.cacheRepository.require(source);
			const rows = instance.context.db
				.select()
				.from(schema.narInfos)
				.where(eq(schema.narInfos.cacheId, cache.id))
				.orderBy(schema.narInfos.storePathHash)
				.all();
			const row = rows[0];
			if (row === undefined) {
				throw new Error('Missing fixture');
			}
			const result = publicationResultIdentitySchema.parse({
				cache: source,
				cacheGeneration: cache.generation,
				storePath: row.storePath,
				narHash: row.narHash,
				generation: row.generation
			});
			const captureGrants = authorizationDetailsSchema.parse([
				{ type: 'cupboard_cache', cache: source, actions: ['upload:commit'] }
			]);
			const capture = new PublicationManifestCaptureService(instance.context);
			const begin = await capture.captureBegin(source, captureGrants, {
				result: {
					storePath: result.storePath,
					narHash: result.narHash,
					generation: result.generation
				},
				expectedCacheGeneration: cache.generation,
				requestId: createPublicationRequestId(),
				origin: 'build-selection',
				memberCount: rows.length
			});
			if (begin.kind !== 'staging') {
				throw new Error('Expected staging');
			}
			await capture.capturePage(source, captureGrants, {
				operationId: begin.operationId,
				page: 0,
				members: rows.map((member) => ({
					storePath: member.storePath,
					narHash: member.narHash,
					generation: member.generation
				}))
			});
			for (let step = 0; step < 12; step += 1) {
				const sealed = await capture.captureSeal(source, captureGrants, {
					operationId: begin.operationId
				});
				if (sealed.kind === 'captured') {
					return sealed.publication;
				}
			}
			throw new Error('Capture did not converge');
		}
	);
	const request = publicationEnsureRequestSchema.parse({
		requestId: createPublicationRequestId(),
		source: publication,
		expectedDestinationGeneration: 1
	});
	const token = await initialiseViaWorker();
	const resultBytes = await verifiablePath(narSeed, fields);
	const childBytes = await verifiablePath(`${narSeed}-child`, childFields);
	const deadline = isoTimestamp(new Date(Date.now() + 86_400_000));
	// Test-only adapter: actual fixture negotiate/verify/commit, not a production
	// publication-v1 binding. The server-owned replay coordinator is a handoff.
	const publisher: PublicationManifestPublisher = {
		admit: vi.fn(async () => {
			if (options.absent === true) {
				await pushPathToTenant(
					fixtureTenant,
					token,
					resultBytes.metadata,
					resultBytes.nar,
					destination
				);
			}
			return runInDurableObject(fixtureWorkerServer(), (instance) => ({
				cache: instance.context.cacheRepository.require(destination),
				expiresAt: deadline
			}));
		}),
		publish: vi.fn<PublicationManifestPublisher['publish']>(async (input) => {
			const bytes =
				input.source.result.storePath === publication.result.storePath
					? resultBytes
					: childBytes;
			await pushPathToTenant(
				fixtureTenant,
				token,
				bytes.metadata,
				bytes.nar,
				destination
			);
			return runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(destination);
				const hash = StorePath.hash(input.source.result.storePath);
				const row = instance.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, hash)
						)
					)
					.get();
				if (row === undefined) {
					throw new Error('Missing accepted result');
				}
				return {
					kind: 'accepted' as const,
					result: publicationResultIdentitySchema.parse({
						cache: destination,
						cacheGeneration: cache.generation,
						storePath: row.storePath,
						narHash: row.narHash,
						generation: row.generation
					})
				};
			});
		})
	};
	return {
		seed: narSeed,
		source,
		destination,
		grants,
		publication,
		request,
		publisher
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function ensure(f: Fixture, request = f.request) {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		new PublicationManifestEnsureService(instance.context, f.publisher).ensure(
			f.destination,
			f.grants,
			request
		)
	);
}
function advance(f: Fixture, operationId: string) {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		new PublicationManifestEnsureService(
			instance.context,
			f.publisher
		).continue(f.destination, f.grants, {
			operationId: publicationOperationIdSchema.parse(operationId)
		})
	);
}
function status(f: Fixture, operationId: string) {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		new PublicationManifestEnsureService(instance.context, f.publisher).status(
			f.destination,
			f.grants,
			{ operationId: publicationOperationIdSchema.parse(operationId) }
		)
	);
}
async function complete(f: Fixture) {
	const started = await ensure(f);
	if (started.kind === 'complete') {
		return started;
	}
	for (let step = 0; step < 12; step += 1) {
		const response = await advance(f, started.operationId);
		if (response.kind === 'complete') {
			return response;
		}
	}
	throw new Error('Ensure did not converge');
}
function operations(f: Fixture) {
	return runInDurableObject(fixtureWorkerServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(f.destination);
		return instance.context.db
			.select()
			.from(schema.publicationManifestOperations)
			.where(
				and(
					eq(schema.publicationManifestOperations.kind, 'ensure'),
					eq(schema.publicationManifestOperations.cacheId, cache.id)
				)
			)
			.all();
	});
}

async function acceptedEnsureState(context: ServerContext, f: Fixture) {
	const cache = context.cacheRepository.require(f.destination);
	return {
		narinfos: context.db
			.select()
			.from(schema.narInfos)
			.orderBy(schema.narInfos.cacheId, schema.narInfos.storePathHash)
			.all(),
		grace: context.db
			.select()
			.from(schema.retentionGrace)
			.orderBy(
				schema.retentionGrace.cacheId,
				schema.retentionGrace.storePathHash
			)
			.all(),
		roots: context.db
			.select()
			.from(schema.retentionRoots)
			.orderBy(schema.retentionRoots.cacheId, schema.retentionRoots.name)
			.all(),
		targets: context.db
			.select()
			.from(schema.retentionRootTargets)
			.orderBy(
				schema.retentionRootTargets.cacheId,
				schema.retentionRootTargets.rootName,
				schema.retentionRootTargets.storePathHash
			)
			.all(),
		references: await context.d1
			.select()
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.cacheName, f.destination.name))
			.orderBy(d1Schema.blobReference.storePathHash)
			.all(),
		usage: await context.d1.select().from(d1Schema.tenantUsage).all(),
		cache
	};
}

async function ensureCollectionState(f: Fixture) {
	return runInDurableObject(fixtureWorkerServer(), async (instance) => {
		const context = instance.context;
		const objects = await context.env.BLOBS.list();
		return {
			...(await acceptedEnsureState(context, f)),
			operations: context.db
				.select()
				.from(schema.publicationManifestOperations)
				.orderBy(schema.publicationManifestOperations.id)
				.all(),
			holds: context.db
				.select()
				.from(schema.publicationManifestWorkHolds)
				.orderBy(
					schema.publicationManifestWorkHolds.operationId,
					schema.publicationManifestWorkHolds.publicationId
				)
				.all(),
			associations: context.db
				.select()
				.from(schema.resultPublications)
				.orderBy(
					schema.resultPublications.cacheId,
					schema.resultPublications.resultHash
				)
				.all(),
			proofs: context.db
				.select()
				.from(schema.resultPublicationMembers)
				.orderBy(
					schema.resultPublicationMembers.materialisationId,
					schema.resultPublicationMembers.memberHash
				)
				.all(),
			inputs: context.db
				.select()
				.from(schema.garbageCollectionInputs)
				.orderBy(schema.garbageCollectionInputs.cacheId)
				.all(),
			scans: context.db
				.select()
				.from(schema.garbageCollectionScans)
				.orderBy(schema.garbageCollectionScans.cacheId)
				.all(),
			objects: await Promise.all(
				objects.objects.map(async ({ key }) => {
					const object = await context.env.BLOBS.get(key);
					if (object === null) {
						throw new Error('Missing fixture object');
					}
					return {
						key,
						bytes: [...new Uint8Array(await object.arrayBuffer())]
					};
				})
			)
		};
	});
}

/**
Exercise the authoritative mutation, never delete the accepted local row.
*/
async function makeChildKnownUnavailable(
	f: Fixture,
	mutation: 'revoke' | 'demote'
): Promise<void> {
	await runInDurableObject(fixtureWorkerServer(), async (instance) => {
		const cache = instance.context.cacheRepository.require(f.destination);
		const hash = storePathHashSchema.parse('00000000000000000000000000000002');
		const child = instance.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, hash)
				)
			)
			.get();
		if (child === undefined) {
			throw new Error('Missing accepted child');
		}
		const authority = new PublicationManifestAuthority(instance.context);
		const snapshot = authority.resolveTarget(
			f.destination,
			f.grants,
			f.destination,
			{ storePath: child.storePath, narHash: child.narHash }
		);
		expect(await authority.isServable(snapshot)).toBe(true);
		if (mutation === 'revoke') {
			await new PathReadAuthorityService(instance.context).revoke(cache, [
				{ storePathHash: hash, generation: child.generation }
			]);
		} else {
			const blob = await instance.context.d1
				.select()
				.from(d1Schema.blobState)
				.where(eq(d1Schema.blobState.narHash, child.narHash))
				.get();
			if (blob === undefined) {
				throw new Error('Missing canonical NAR state');
			}
			const key = narObjectKey(child.narHash, blob.incarnation);
			await instance.context.env.BLOBS.delete(key);
			expect(await instance.context.env.BLOBS.head(key)).toBeNull();
			await instance.demoteNarInfoObjects([
				{
					narHash: child.narHash,
					targets: [{ cache: f.destination, storePathHash: hash }]
				}
			]);
		}
		const retained = instance.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, hash)
				)
			)
			.get();
		expect(retained).toStrictEqual(child);
		expect(await authority.isServable(snapshot)).toBe(false);
	});
}

beforeEach(async () => {
	vi.restoreAllMocks();
	await resetTestServer();
});

describe('PublicationManifestEnsureService', () => {
	it.each(['none', 'root', 'grace', 'rollback'] as const)(
		'releases pre-operation orphan admission work on direct completion with %s protection',
		async (protection) => {
			vi.setSystemTime(vi.getRealSystemTime());
			const server = fixtureWorkerServer();
			const timestamp: unknown = expect.any(String);
			const sqlNull: unknown = expect.toSatisfy(
				(value: unknown) => value === null
			);
			const prepared = await withoutAlarmArming(async () => {
				const f = await fixture({
					absent: true,
					graceSeconds: protection === 'grace' ? 3600 : 0
				});
				const token = await initialiseViaWorker();
				if (protection === 'root') {
					const name = rootNameSchema.parse('run/orphan-release');
					const root = await authorisedWorkerFetch(
						`/cache/${f.destination.name}/uploads`,
						token,
						{
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								pushId: await testPushIdFor(fixtureTenant),
								paths: [],
								attachRoot: {
									name,
									retention: { kind: 'duration', seconds: 3600 }
								}
							})
						}
					);
					expect(root.status).toBe(200);
					f.request = { ...f.request, runRoot: name };
				}
				const call = (request = f.request) =>
					authorisedWorkerFetch(
						`/cache/${f.destination.name}/publication-results/ensure`,
						token,
						{
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(request)
						}
					);
				const snapshot = async () => {
					const state = await ensureCollectionState(f);
					const sourceId = await runInDurableObject(
						server,
						(instance) => instance.context.cacheRepository.require(f.source).id
					);
					const isFixtureCache = ({ cacheId }: { cacheId: number }) =>
						cacheId === state.cache.id || cacheId === sourceId;
					const extra = await runInDurableObject(server, (instance) => ({
						admissions: instance.context.db
							.select()
							.from(schema.publicationManifestAdmissions)
							.orderBy(schema.publicationManifestAdmissions.operationId)
							.all(),
						mappings: instance.context.db
							.select()
							.from(schema.publicationManifestOperationPages)
							.orderBy(
								schema.publicationManifestOperationPages.operationId,
								schema.publicationManifestOperationPages.page
							)
							.all(),
						ordinary: instance.context.db
							.select()
							.from(schema.publicationOperations)
							.orderBy(schema.publicationOperations.id)
							.all(),
						pending: instance.context.db
							.select()
							.from(schema.pendingUploads)
							.orderBy(schema.pendingUploads.id)
							.all()
					}));
					return {
						...state,
						narinfos: state.narinfos.filter((row) => isFixtureCache(row)),
						grace: state.grace.filter((row) => isFixtureCache(row)),
						roots: state.roots.filter((row) => isFixtureCache(row)),
						targets: state.targets.filter((row) => isFixtureCache(row)),
						operations: state.operations.filter((row) => isFixtureCache(row)),
						holds: state.holds.filter((row) => isFixtureCache(row)),
						associations: state.associations.filter((row) =>
							isFixtureCache(row)
						),
						proofs: state.proofs.filter((row) => isFixtureCache(row)),
						inputs: state.inputs.filter((row) => isFixtureCache(row)),
						scans: state.scans.filter((row) => isFixtureCache(row)),
						objects: state.objects.filter(
							({ key }) =>
								key.startsWith(`nar/${f.publication.result.narHash}.`) ||
								[f.source, f.destination].some(
									(cache) =>
										key ===
										narInfoObjectKey(
											fixtureTenant,
											StorePath.hash(f.publication.result.storePath),
											cache,
											state.cache.generation
										)
								)
						),

						admissions: extra.admissions.filter(
							(row) => row.cacheId === state.cache.id
						),
						mappings: extra.mappings.filter(({ operationId }) =>
							extra.admissions.some(
								(row) =>
									row.cacheId === state.cache.id &&
									row.operationId === operationId
							)
						),
						ordinary: extra.ordinary.filter((row) => isFixtureCache(row)),
						pending: extra.pending.filter((row) => isFixtureCache(row))
					};
				};
				const admissionDescriptor:
					| TypedPropertyDescriptor<
							ProductionPublicationManifestPublisher['admit']
					  >
					| undefined = Object.getOwnPropertyDescriptor(
					ProductionPublicationManifestPublisher.prototype,
					'admit'
				);
				const original = admissionDescriptor?.value;
				if (original === undefined) {
					throw new Error('Missing production admission');
				}
				const interrupted = vi
					.spyOn(ProductionPublicationManifestPublisher.prototype, 'admit')
					.mockImplementationOnce(async function (
						this: ProductionPublicationManifestPublisher,
						input
					) {
						await original.call(this, input);
						throw new Error(
							'interrupt after ordinary result before manifest operation'
						);
					});
				try {
					const stopped = await call();
					expect(stopped.status).toBe(500);
				} finally {
					interrupted.mockRestore();
				}
				const orphan = await snapshot();
				const admission = orphan.admissions.find(
					({ canonicalJson }) => canonicalJson === JSON.stringify(f.request)
				);
				const row = orphan.narinfos.find(
					({ cacheId }) => cacheId === orphan.cache.id
				);
				const ordinary = orphan.ordinary.find(
					({ pushId }) => pushId === admission?.pushId
				);
				if (
					admission === undefined ||
					row === undefined ||
					ordinary === undefined
				) {
					throw new Error('Missing real orphan admission/result/publication');
				}
				const sourceRow = orphan.narinfos.find(
					({ cacheId }) => cacheId !== orphan.cache.id
				);
				if (sourceRow === undefined) {
					throw new Error('Missing accepted source result');
				}
				expect(orphan.narinfos).toStrictEqual(
					[sourceRow, { ...sourceRow, cacheId: orphan.cache.id }].toSorted(
						(left, right) => left.cacheId - right.cacheId
					)
				);
				const deadline =
					Math.floor((Date.now() + publicationRecoveryMs) / 1000) * 1000;
				const expiresAt = isoTimestamp(new Date(deadline));
				const pruneAfter = isoTimestamp(
					new Date(Date.parse(expiresAt) + publicationCleanupMarginMs)
				);
				const graceDeadline =
					protection === 'grace'
						? isoTimestamp(new Date(Date.now() + 3_600_000))
						: sqlNull;
				expect(orphan.admissions).toStrictEqual([
					{
						operationId: admission.operationId,
						destinationKind: 'named',
						destinationName: f.destination.name,
						cacheId: orphan.cache.id,
						cacheGeneration: 1,
						canonicalJson: JSON.stringify(f.request),
						pushId: admission.pushId,
						expiresAt,
						pruneAfter
					}
				]);
				expect(
					orphan.operations.filter(({ kind }) => kind === 'ensure')
				).toStrictEqual([]);
				expect(orphan.pending).toStrictEqual([]);
				const metadata = uploadPathNegotiationSchema.parse({
					storePathHash: row.storePathHash,
					storePath: row.storePath,
					narHash: row.narHash,
					narSize: row.narSize,
					references: [`${row.storePathHash}-result`]
				});
				const identity = await publicationIdentity({
					tenant: fixtureTenant,
					cache: f.destination,
					cacheGeneration: orphan.cache.generation,
					pushId: admission.pushId,
					metadata
				});
				expect(
					orphan.ordinary.filter(({ pushId }) => pushId === admission.pushId)
				).toStrictEqual([
					{
						id: identity.id,
						canonicalJson: identity.canonical,
						pushId: admission.pushId,
						acceptedAt: isoTimestamp(new Date()),
						blobJson: sqlNull,
						rootExpiresAt: sqlNull,
						graceDecisionJson: JSON.stringify({
							reportsGrace: true,
							graceSeconds: protection === 'grace' ? 3600 : 0,
							retentionEpoch: 0,
							publicationId: identity.id,
							recoveryDeadline: admission.expiresAt
						}),
						cacheId: orphan.cache.id,
						cacheGeneration: 1,
						state: 'servable',
						manifestOperationId: admission.operationId,
						pushExpiresAt: admission.expiresAt,
						recoveryDeadline: admission.expiresAt,
						pruneAfter: admission.pruneAfter,
						graceDeadline,
						resultJson: JSON.stringify({
							storePathHash: row.storePathHash,
							narHash: row.narHash,
							generation: row.generation
						})
					}
				]);
				expect(
					orphan.mappings.filter(
						({ operationId }) => operationId === admission.operationId
					)
				).toStrictEqual([
					{
						operationId: admission.operationId,
						page: 0,
						payloadDigest: ordinary.id,
						payloadJson: JSON.stringify({
							kind: 'ensure-member-admission',
							storePath: row.storePath,
							publicationId: ordinary.id
						})
					}
				]);
				expect(orphan.holds).toStrictEqual([
					{
						operationId: admission.operationId,
						publicationId: ordinary.id,
						cacheId: orphan.cache.id,
						cacheGeneration: orphan.cache.generation,
						storePathHash: row.storePathHash,
						storePath: row.storePath,
						narHash: row.narHash,
						generation: row.generation
					}
				]);
				const winning = await call({
					...f.request,
					requestId: createPublicationRequestId()
				});
				expect(winning.status).toBe(200);
				const winner = publicationEnsureResponseSchema.parse(
					await winning.json()
				);
				const response = {
					kind: 'complete' as const,
					association: 'existing' as const,
					publication: {
						...f.publication,
						materialisation: 'complete' as const,
						result: publicationResultIdentitySchema.parse({
							cache: f.destination,
							cacheGeneration: orphan.cache.generation,
							storePath: row.storePath,
							narHash: row.narHash,
							generation: row.generation
						})
					}
				};
				expect(winner).toStrictEqual({ ...response, association: 'created' });
				const selected = await snapshot();
				for (let pass = 0; pass < 12; pass += 1) {
					await server.runGarbageCollection();
				}
				let scanned = await snapshot();
				expect(scanned).toStrictEqual({
					...selected,
					holds: orphan.holds,
					inputs: selected.inputs.map((input) => ({
						...input,
						inputsChanged: false,
						scanCompletedAt: timestamp
					})),
					scans: []
				});
				await runInDurableObject(server, (instance) => {
					const now = isoTimestamp(new Date());
					expect(
						new GarbageCollectionInputs(instance.context).scanDecision(
							scanned.cache,
							now
						)
					).toBe('current');
				});
				// Advance time so a renewed deadline cannot match the original.
				vi.setSystemTime(Date.now() + 60_000);
				if (protection === 'none') {
					const freshRequest = {
						...f.request,
						requestId: createPublicationRequestId()
					};
					await runInDurableObject(server, (_instance, state) => {
						state.storage.sql.exec(
							`CREATE TRIGGER reject_warm_dirty BEFORE UPDATE OF inputs_changed ON garbage_collection_input WHEN NEW.cache_id = ${String(scanned.cache.id)} BEGIN SELECT RAISE(ABORT, 'fresh warm call dirtied inputs'); END`
						);
					});
					try {
						const fresh = await call(freshRequest);
						expect(fresh.status).toBe(200);
						expect(
							publicationEnsureResponseSchema.parse(await fresh.json())
						).toStrictEqual(response);
						const warmed = await snapshot();
						const operation = warmed.operations.find(
							({ requestId }) => requestId === freshRequest.requestId
						);
						if (operation === undefined) {
							throw new Error('Missing fresh warm receipt');
						}
						const warmExpiresAt = isoTimestamp(
							new Date(Date.now() + publicationRecoveryMs)
						);
						expect(warmed).toStrictEqual({
							...scanned,
							operations: [
								...scanned.operations,
								{
									id: operation.id,
									requestId: freshRequest.requestId,
									kind: 'ensure',
									cacheId: scanned.cache.id,
									cacheGeneration: scanned.cache.generation,
									canonicalJson: JSON.stringify(freshRequest),
									sourceJson: JSON.stringify(freshRequest),
									resultIdentityJson: JSON.stringify(
										response.publication.result
									),
									origin: f.publication.origin,
									expectedCount: 1,
									nextPage: 0,
									cursor: 0,
									phase: 'publishing',
									candidateDigest: f.publication.digest,
									progressJson: '{"phase":"result"}',
									state: 'complete',
									expiresAt: warmExpiresAt,
									resultJson: JSON.stringify(response),
									failureJson: sqlNull
								}
							].toSorted((left, right) => left.id.localeCompare(right.id))
						});
						scanned = warmed;
					} finally {
						await runInDurableObject(server, (_instance, state) => {
							state.storage.sql.exec('DROP TRIGGER reject_warm_dirty');
						});
					}
				} else if (protection === 'rollback') {
					await runInDurableObject(server, (_instance, state) => {
						state.storage.sql.exec(
							`CREATE TRIGGER reject_orphan_release BEFORE UPDATE OF inputs_changed ON garbage_collection_input WHEN NEW.cache_id = ${String(scanned.cache.id)} AND NEW.inputs_changed = 1 BEGIN SELECT RAISE(ABORT, 'orphan release rollback'); END`
						);
					});
					const rolledBack = await call();
					expect(rolledBack.status).toBe(500);
					expect(await snapshot()).toStrictEqual(scanned);
					await runInDurableObject(server, (_instance, state) => {
						state.storage.sql.exec('DROP TRIGGER reject_orphan_release');
					});
				}
				const ensureDescriptor:
					| TypedPropertyDescriptor<PublicationManifestEnsureService['ensure']>
					| undefined = Object.getOwnPropertyDescriptor(
					PublicationManifestEnsureService.prototype,
					'ensure'
				);
				const ensureOriginal = ensureDescriptor?.value;
				if (ensureOriginal === undefined) {
					throw new Error('Missing ensure service');
				}
				let cost: { rowsRead: number; rowsWritten: number } | undefined;
				const measured = vi
					.spyOn(PublicationManifestEnsureService.prototype, 'ensure')
					.mockImplementationOnce(async function (
						this: PublicationManifestEnsureService,
						...arguments_
					) {
						const meter = currentRowBudgetMeter();
						if (meter === undefined) {
							throw new Error('Missing ensure cost meter');
						}
						meter.recordOutstanding();
						const before = {
							rowsRead: meter.rowsRead,
							rowsWritten: meter.rowsWritten
						};
						const result = await ensureOriginal.apply(this, arguments_);
						meter.recordOutstanding();
						cost = {
							rowsRead: meter.rowsRead - before.rowsRead,
							rowsWritten: meter.rowsWritten - before.rowsWritten
						};
						return result;
					});
				let recovered: Awaited<ReturnType<typeof call>>;
				try {
					recovered = await call();
				} finally {
					measured.mockRestore();
				}
				expect(cost).toStrictEqual({
					rowsRead: protection === 'root' ? 143 : 137,
					rowsWritten: 11
				});
				expect(recovered.status).toBe(200);
				expect(
					publicationEnsureResponseSchema.parse(await recovered.json())
				).toStrictEqual(response);
				const completed = await snapshot();
				expect.soft(completed).toStrictEqual({
					...scanned,
					operations: [
						...scanned.operations,
						{
							id: admission.operationId,
							requestId: f.request.requestId,
							kind: 'ensure',
							cacheId: scanned.cache.id,
							cacheGeneration: scanned.cache.generation,
							canonicalJson: JSON.stringify(f.request),
							sourceJson: JSON.stringify(f.request),
							resultIdentityJson: JSON.stringify(response.publication.result),
							origin: f.publication.origin,
							expectedCount: 1,
							nextPage: 0,
							cursor: 0,
							phase: 'publishing',
							candidateDigest: f.publication.digest,
							progressJson: '{"phase":"result"}',
							state: 'complete',
							expiresAt: admission.expiresAt,
							resultJson: JSON.stringify(response),
							failureJson: sqlNull
						}
					].toSorted((left, right) => left.id.localeCompare(right.id)),
					inputs: scanned.inputs.map((input) =>
						input.cacheId === scanned.cache.id
							? { ...input, inputsChanged: true }
							: input
					)
				});
				const replay = await call();
				expect(replay.status).toBe(200);
				expect(
					publicationEnsureResponseSchema.parse(await replay.json())
				).toStrictEqual(response);
				expect(await snapshot()).toStrictEqual(completed);
				return {
					f,
					scanned,
					completed,
					response,
					admission,
					row,
					snapshot,
					call
				};
			}, server);
			await runMaintenanceBatch(rootLogger(), { ...env, ...testControlEnv });
			for (let pass = 0; pass < 12; pass += 1) {
				await runInDurableObject(server, (instance) => instance.alarm());
			}
			const final = await prepared.snapshot();
			const owner = prepared.scanned.cache.id;
			const isRetained = protection === 'root' || protection === 'grace';
			const removedKey = narInfoObjectKey(
				fixtureTenant,
				prepared.row.storePathHash,
				prepared.f.destination,
				prepared.scanned.cache.generation
			);
			expect(final).toStrictEqual({
				...prepared.completed,
				holds: [],
				narinfos: prepared.completed.narinfos.filter(
					({ cacheId }) => isRetained || cacheId !== owner
				),
				references: isRetained ? prepared.completed.references : [],
				associations: prepared.completed.associations.filter(
					({ cacheId }) => isRetained || cacheId !== owner
				),
				proofs: prepared.completed.proofs.filter(
					({ cacheId }) => isRetained || cacheId !== owner
				),
				objects: prepared.completed.objects.filter(
					({ key }) => isRetained || key !== removedKey
				),
				usage: prepared.completed.usage.map((usage) =>
					isRetained
						? usage
						: { ...usage, narinfos: usage.narinfos - 1, updatedAt: timestamp }
				),
				inputs: prepared.completed.inputs.map((input) =>
					input.cacheId === owner
						? { ...input, inputsChanged: false, scanCompletedAt: timestamp }
						: input
				),
				scans: []
			});
			if (!isRetained) {
				return;
			}
			const replay = await prepared.call();
			expect(replay.status).toBe(200);
			expect(
				publicationEnsureResponseSchema.parse(await replay.json())
			).toStrictEqual(prepared.response);
			expect(await prepared.snapshot()).toStrictEqual(final);
		}
	);

	for (const completion of ['new-winner', 'coalesced'] as const) {
		for (const protection of ['none', 'root', 'grace', 'rollback'] as const) {
			it(`announces ${completion} hold release atomically and maintenance respects ${protection} protection`, async () => {
				const server = fixtureWorkerServer();
				const timestamp: unknown = expect.any(String);
				const prepared = await withoutAlarmArming(async () => {
					const f = await fixture({
						child: true,
						graceSeconds: protection === 'grace' ? 3600 : 0
					});
					if (protection === 'root') {
						const name = rootNameSchema.parse('run/hold-release');
						await runInDurableObject(server, (instance) => {
							const cache = instance.context.cacheRepository.require(
								f.destination
							);
							const timestamp = isoTimestamp(new Date());
							const expiry = new Date(Date.now() + 3_600_000);
							const expiresAt = isoTimestamp(expiry);
							instance.context.db
								.insert(schema.retentionRoots)
								.values({
									cacheId: cache.id,
									name,
									createdAt: timestamp,
									updatedAt: timestamp,
									expiresAt
								})
								.run();
						});
						f.request = { ...f.request, runRoot: name };
					}
					const started = await ensure(f);
					if (started.kind !== 'pending') {
						throw new Error('Expected pending candidate A');
					}
					for (let step = 0; step < 3; step += 1) {
						expect(await advance(f, started.operationId)).toStrictEqual(
							started
						);
					}
					const accepted = await ensureCollectionState(f);
					const operation = accepted.operations.find(
						({ id }) => id === started.operationId
					);
					if (operation === undefined) {
						throw new Error('Missing candidate A');
					}
					expect({ ...operation, state: 'pending', cursor: 2 }).toStrictEqual(
						operation
					);
					const destinationRows = accepted.narinfos.filter(
						({ cacheId }) => cacheId === accepted.cache.id
					);
					expect(
						accepted.holds.filter(
							({ operationId }) => operationId === operation.id
						)
					).toStrictEqual(
						destinationRows.map((row) => ({
							operationId: operation.id,
							publicationId: `manifest-destination:${row.storePath}`,
							cacheId: row.cacheId,
							cacheGeneration: accepted.cache.generation,
							storePathHash: row.storePathHash,
							storePath: row.storePath,
							narHash: row.narHash,
							generation: row.generation
						}))
					);
					let winningReceipt;
					if (completion === 'coalesced') {
						winningReceipt = await complete({
							...f,
							request: { ...f.request, requestId: createPublicationRequestId() }
						});
					}
					const beforeScan = await ensureCollectionState(f);
					// Finish a genuine scan while A's exact-version holds are still live.
					for (let pass = 0; pass < 12; pass += 1) {
						await server.runGarbageCollection();
					}
					const scanned = await ensureCollectionState(f);
					expect(scanned).toStrictEqual({
						...scanned,
						narinfos: accepted.narinfos,
						grace: accepted.grace,
						roots: accepted.roots,
						targets: beforeScan.targets,
						references: accepted.references,
						usage: accepted.usage,
						objects: accepted.objects,
						scans: []
					});
					expect(
						scanned.operations.find(({ id }) => id === operation.id)
					).toStrictEqual(operation);
					expect(
						scanned.holds.filter(
							({ operationId }) => operationId === operation.id
						)
					).toStrictEqual(
						accepted.holds.filter(
							({ operationId }) => operationId === operation.id
						)
					);
					const ownerInput = scanned.inputs.find(
						({ cacheId }) => cacheId === scanned.cache.id
					);
					expect(ownerInput).toStrictEqual({
						cacheId: scanned.cache.id,
						inputsChanged: false,
						scanCompletedAt: timestamp
					});
					await runInDurableObject(server, (instance) => {
						const inputs = new GarbageCollectionInputs(instance.context);
						const now = isoTimestamp(new Date());
						expect(inputs.scanDecision(scanned.cache, now)).toBe('current');
					});
					if (protection === 'rollback') {
						await runInDurableObject(server, (_instance, state) => {
							state.storage.sql.exec(
								`CREATE TRIGGER reject_ensure_hold_release BEFORE UPDATE OF inputs_changed ON garbage_collection_input WHEN NEW.cache_id = ${String(scanned.cache.id)} AND NEW.inputs_changed = 1 BEGIN SELECT RAISE(ABORT, 'hold release rollback'); END`
							);
						});
						await expect(advance(f, operation.id)).rejects.toThrow(
							'hold release rollback'
						);
						expect(await ensureCollectionState(f)).toStrictEqual(scanned);
						await runInDurableObject(server, (_instance, state) => {
							state.storage.sql.exec('DROP TRIGGER reject_ensure_hold_release');
						});
					}
					const response = await advance(f, operation.id);
					if (response.kind !== 'complete') {
						throw new Error('Expected completed candidate A');
					}
					if (winningReceipt !== undefined) {
						expect(response).toStrictEqual({
							...winningReceipt,
							association: 'existing'
						});
					}
					const completed = await ensureCollectionState(f);
					expect(completed.operations).toStrictEqual(
						scanned.operations.map((row) =>
							row.id === operation.id
								? {
										...row,
										state: 'complete',
										resultJson: JSON.stringify(response)
									}
								: row
						)
					);
					expect
						.soft(completed.inputs)
						.toStrictEqual(
							scanned.inputs.map((row) =>
								row.cacheId === scanned.cache.id
									? { ...row, inputsChanged: true }
									: row
							)
						);
					if (completion === 'coalesced') {
						expect(completed).toStrictEqual({
							...scanned,
							operations: completed.operations,
							inputs: completed.inputs
						});
					} else {
						expect(completed).toStrictEqual({
							...scanned,
							operations: completed.operations,
							inputs: completed.inputs,
							targets:
								f.request.runRoot === undefined
									? scanned.targets
									: [
											...scanned.targets,
											{
												cacheId: scanned.cache.id,
												rootName: f.request.runRoot,
												storePath: response.publication.result.storePath,
												storePathHash: StorePath.hash(
													response.publication.result.storePath
												)
											}
										].toSorted((left, right) => left.cacheId - right.cacheId),
							associations: [
								...scanned.associations,
								{
									cacheId: scanned.cache.id,
									cacheGeneration: scanned.cache.generation,
									resultHash: StorePath.hash(
										response.publication.result.storePath
									),
									resultPath: response.publication.result.storePath,
									resultGeneration: response.publication.result.generation,
									resultNarHash: response.publication.result.narHash,
									digest: response.publication.digest,
									origin: response.publication.origin,
									materialisationId: operation.id,
									complete: true
								}
							].toSorted((left, right) => left.cacheId - right.cacheId)
						});
					}
					return {
						f,
						scanned,
						completed,
						response,
						operation,
						destinationRows
					};
				}, server);
				await runMaintenanceBatch(rootLogger(), { ...env, ...testControlEnv });
				for (let pass = 0; pass < 12; pass += 1) {
					await runInDurableObject(server, (instance) => instance.alarm());
				}
				const final = await ensureCollectionState(prepared.f);
				if (protection === 'root' || protection === 'grace') {
					expect(final).toStrictEqual({
						...prepared.completed,
						holds: prepared.completed.holds.filter(
							({ cacheId }) => cacheId !== prepared.scanned.cache.id
						),
						inputs: prepared.completed.inputs.map((row) =>
							row.cacheId === prepared.scanned.cache.id
								? {
										...row,
										inputsChanged: false,
										scanCompletedAt: timestamp
									}
								: row
						),
						scans: []
					});
					expect(await ensure(prepared.f)).toStrictEqual(prepared.response);
					expect(
						await advance(prepared.f, prepared.operation.id)
					).toStrictEqual(prepared.response);
					expect(await status(prepared.f, prepared.operation.id)).toStrictEqual(
						prepared.response
					);
					expect(await ensureCollectionState(prepared.f)).toStrictEqual(final);
				} else {
					const owner = prepared.scanned.cache.id;
					const selected = prepared.completed.associations.find(
						({ cacheId }) => cacheId === owner
					);
					if (selected === undefined) {
						throw new Error('Missing selected association');
					}
					const removedKeys = new Set<string>(
						prepared.destinationRows.map((row) =>
							narInfoObjectKey(
								fixtureTenant,
								row.storePathHash,
								prepared.f.destination,
								prepared.scanned.cache.generation
							)
						)
					);
					expect(final).toStrictEqual({
						...prepared.completed,
						narinfos: prepared.completed.narinfos.filter(
							({ cacheId }) => cacheId !== owner
						),
						references: [],
						holds: prepared.completed.holds.filter(
							({ cacheId }) => cacheId !== owner
						),
						associations: prepared.completed.associations.filter(
							({ cacheId }) => cacheId !== owner
						),
						proofs: prepared.completed.proofs.filter(
							({ materialisationId }) =>
								materialisationId !== selected.materialisationId
						),
						inputs: prepared.completed.inputs.map((row) =>
							row.cacheId === owner
								? {
										...row,
										inputsChanged: false,
										scanCompletedAt: timestamp
									}
								: row
						),
						scans: [],
						objects: prepared.completed.objects.filter(
							({ key }) => !removedKeys.has(key)
						),
						usage: prepared.completed.usage.map((usage) => ({
							...usage,
							narinfos: usage.narinfos - 2,
							updatedAt: timestamp
						}))
					});
				}
			});
		}
	}

	for (const mutation of ['revoke', 'demote'] as const) {
		for (const shouldRestart of [false, true]) {
			it(`does not replay complete after known child ${mutation}, restart=${String(shouldRestart)}`, async () => {
				const { f, operation } = await withoutAlarmArming(async () => {
					const f = await fixture({ same: true, child: true });
					const warm = await ensure(f);
					expect(warm.kind).toBe('complete');
					const [operation] = await operations(f);
					if (operation === undefined) {
						throw new Error('Missing complete receipt');
					}
					await makeChildKnownUnavailable(f, mutation);
					return { f, operation };
				}, fixtureWorkerServer());
				if (shouldRestart) {
					await restartTestServers();
				}
				expect.soft(await status(f, operation.id)).toStrictEqual({
					kind: 'failed',
					reason: 'result-changed'
				});
				await expect(ensure(f)).rejects.toMatchObject({
					code: 'PUBLICATION_RESULT_CHANGED'
				});
			});
		}
	}

	for (const side of ['source', 'destination'] as const) {
		for (const timing of ['before', 'during'] as const) {
			it(`rejects ensure ${side} proof begun ${timing} mutation after drain`, async () => {
				await withoutAlarmArming(async () => {
					const f = await fixture();
					const started = await ensure(f);
					if (started.kind !== 'pending') {
						throw new Error('Expected cold ensure');
					}
					await runInDurableObject(fixtureWorkerServer(), async (instance) => {
						const cache = instance.context.cacheRepository.require(
							side === 'source' ? f.source : f.destination
						);
						const row = instance.context.db
							.select()
							.from(schema.narInfos)
							.where(eq(schema.narInfos.cacheId, cache.id))
							.get();
						if (row === undefined) {
							throw new Error('Missing member');
						}
						const availability = new PublicationManifestAvailabilityStore(
							instance.context.db
						);
						const version = {
							cacheId: cache.id,
							cacheGeneration: cache.generation,
							storePathHash: row.storePathHash,
							generation: row.generation,
							storePath: row.storePath,
							narHash: row.narHash
						};
						const intent =
							timing === 'during'
								? availability.begin(version, 'revoke')
								: undefined;
						const authority = new PublicationManifestAuthority(
							instance.context
						);
						const isServable = authority.isServable.bind(authority);
						let isIntercepted = false;
						const isServableSpy = vi
							.spyOn(PublicationManifestAuthority.prototype, 'isServable')
							.mockImplementation(async (snapshot) => {
								if (isIntercepted || snapshot.cache.id !== cache.id) {
									return isServable(snapshot);
								}
								isIntercepted = true;
								if (intent !== undefined) {
									expect(snapshot.availability.unresolved).toBe(true);
									availability.acknowledge(intent.revision);
									availability.drainPage(intent.revision);
									return isServable(snapshot);
								}
								const isHealthy = await isServable(snapshot);
								expect(isHealthy).toBe(true);
								await new PathReadAuthorityService(instance.context).revoke(
									cache,
									[version]
								);
								return isHealthy;
							});
						try {
							await expect(
								new PublicationManifestEnsureService(
									instance.context,
									f.publisher
								).continue(f.destination, f.grants, {
									operationId: started.operationId
								})
							).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
							expect(isIntercepted).toBe(timing === 'before');
							if (intent !== undefined) {
								const authority = new PublicationManifestAuthority(
									instance.context
								);
								const during = authority.resolveTarget(
									f.destination,
									f.grants,
									cache.scope,
									row,
									cache.generation
								);
								expect(during.availability.unresolved).toBe(true);
								availability.acknowledge(intent.revision);
								availability.drainPage(intent.revision);
								expect(await isServable(during)).toBe(false);
								expect(() => authority.revalidate(during, f.grants)).toThrow(
									expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' })
								);
							}
							expect(availability.hasPending(version)).toBe(false);
							expect(
								instance.context.db
									.select()
									.from(schema.resultPublicationMembers)
									.where(
										eq(
											schema.resultPublicationMembers.materialisationId,
											started.operationId
										)
									)
									.all()
							).toHaveLength(0);
						} finally {
							isServableSpy.mockRestore();
						}
					});
				}, fixtureWorkerServer());
			});
		}
	}

	for (const mutation of ['revoke', 'demote'] as const) {
		for (const isSuperseded of [false, true]) {
			it(`recovers ambiguous ${mutation} after real reset, superseded=${String(isSuperseded)}`, async () => {
				const observed = await withoutAlarmArming(async () => {
					const f = await fixture({ same: true });
					await ensure(f);
					return runInDurableObject(fixtureWorkerServer(), async (instance) => {
						const cache = instance.context.cacheRepository.require(f.source);
						const row = instance.context.db
							.select()
							.from(schema.narInfos)
							.where(eq(schema.narInfos.cacheId, cache.id))
							.get();
						if (row === undefined) {
							throw new Error('Missing accepted row');
						}
						if (mutation === 'revoke') {
							const batch = instance.context.d1.batch.bind(instance.context.d1);
							const write = vi
								.spyOn(instance.context.d1, 'batch')
								.mockImplementationOnce(async (...arguments_) => {
									await batch(...arguments_);
									throw new Error('ambiguous D1');
								});
							try {
								await expect(
									new PathReadAuthorityService(instance.context).revoke(cache, [
										row
									])
								).rejects.toThrow('ambiguous D1');
							} finally {
								write.mockRestore();
							}
						} else {
							const blob = await instance.context.d1
								.select()
								.from(d1Schema.blobState)
								.where(eq(d1Schema.blobState.narHash, row.narHash))
								.get();
							if (blob === undefined) {
								throw new Error('Missing blob');
							}
							await instance.context.env.BLOBS.delete(
								narObjectKey(row.narHash, blob.incarnation)
							);
							const remove = instance.context.env.BLOBS.delete.bind(
								instance.context.env.BLOBS
							);
							const write = vi
								.spyOn(instance.context.env.BLOBS, 'delete')
								.mockImplementationOnce(async (...arguments_) => {
									await remove(...arguments_);
									throw new Error('ambiguous R2');
								});
							try {
								await expect(
									new NarInfoObjectsService(instance.context).demoteUnbacked(
										cache,
										row.storePathHash,
										row.narHash
									)
								).rejects.toThrow('ambiguous R2');
							} finally {
								write.mockRestore();
							}
						}
						const availability = new PublicationManifestAvailabilityStore(
							instance.context.db
						);
						const intent = instance.context.db
							.select()
							.from(schema.publicationManifestAvailabilityIntents)
							.where(
								eq(
									schema.publicationManifestAvailabilityIntents.cacheId,
									cache.id
								)
							)
							.get();
						expect(intent?.remotePending).toBe(true);
						expect(
							availability.hasPending({
								cacheId: cache.id,
								cacheGeneration: cache.generation
							})
						).toBe(true);
						if (intent === undefined) {
							throw new Error('Missing original intent');
						}
						if (isSuperseded) {
							instance.context.db
								.update(schema.narInfos)
								.set({
									generation: narInfoGenerationSchema.parse(row.generation + 1)
								})
								.where(eq(schema.narInfos.cacheId, cache.id))
								.run();
						}
						return { f, intent };
					});
				}, fixtureWorkerServer());
				await restartTestServers();
				await withoutAlarmArming(async () => {
					await runInDurableObject(fixtureWorkerServer(), async (instance) => {
						const availability = new PublicationManifestAvailabilityStore(
							instance.context.db
						);
						expect(
							availability.getIntent(observed.intent.revision)
						).toStrictEqual(observed.intent);
						const remove = vi.spyOn(instance.context.env.BLOBS, 'delete');
						const batch = vi.spyOn(instance.context.d1, 'batch');
						try {
							if (isSuperseded) {
								await instance.context.criticalSection(() =>
									mutation === 'demote'
										? new NarInfoObjectsService(
												instance.context
											).recoverAvailability(observed.intent)
										: new PathReadAuthorityService(
												instance.context
											).recoverAvailability(observed.intent)
								);
							} else {
								for (
									let pass = 0;
									pass < 12 &&
									availability.getIntent(observed.intent.revision) !==
										undefined;
									pass += 1
								) {
									await instance.alarm();
								}
							}
							expect(
								availability.getIntent(observed.intent.revision)
							).toBeUndefined();
							if (isSuperseded) {
								expect(remove).not.toHaveBeenCalled();
								expect(batch).not.toHaveBeenCalled();
							}
						} finally {
							remove.mockRestore();
							batch.mockRestore();
						}
					});
				}, fixtureWorkerServer());
			});
		}
	}

	it('retries an unrelated global-clock mutation without poisoning a healthy warm certificate or publishing members', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture({ same: true, child: true });
			const unrelated = await fixture({ same: true });
			const warm = await ensure(f);
			expect(warm.kind).toBe('complete');
			const request = { ...f.request, requestId: createPublicationRequestId() };
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const enter = instance.context.criticalSection.bind(instance.context);
				const gate = vi
					.spyOn(instance.context, 'criticalSection')
					.mockImplementationOnce(async (run) => {
						const cache = instance.context.cacheRepository.require(
							unrelated.source
						);
						const row = instance.context.db
							.select()
							.from(schema.narInfos)
							.where(eq(schema.narInfos.cacheId, cache.id))
							.get();
						if (row === undefined) {
							throw new Error('Missing unrelated accepted path');
						}
						await enter(() =>
							new PathReadAuthorityService(instance.context).revoke(cache, [
								row
							])
						);
						return enter(run);
					});
				const probe = vi.spyOn(
					PublicationManifestAuthority.prototype,
					'requireServable'
				);
				try {
					const service = new PublicationManifestEnsureService(
						instance.context,
						f.publisher
					);
					await expect(
						service.ensure(f.destination, f.grants, request)
					).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
					expect(gate).toHaveBeenCalledOnce();
					const retried = await service.ensure(
						f.destination,
						f.grants,
						request
					);
					expect(retried.kind).toBe('complete');
					expect(probe).not.toHaveBeenCalled();
					expect(f.publisher.admit).not.toHaveBeenCalled();
					expect(f.publisher.publish).not.toHaveBeenCalled();
				} finally {
					gate.mockRestore();
					probe.mockRestore();
				}
			});
		}, fixtureWorkerServer());
	});

	for (const isRecursive of [false, true]) {
		for (const mutation of ['delete', 'revoke'] as const) {
			it(`preserves cold result proof on ordinal replay after unrelated ${mutation}, recursive=${String(isRecursive)}`, async () => {
				const observed = await withoutAlarmArming(async () => {
					const f = await fixture({ child: true });
					const unrelated = await fixture({ same: true });
					const started = await ensure(f);
					if (started.kind !== 'pending') {
						throw new Error('Expected cold ensure');
					}
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						instance.context.ctx.storage.sql.exec(
							`PRAGMA recursive_triggers=${isRecursive ? 'ON' : 'OFF'}`
						);
					});
					expect(await advance(f, started.operationId)).toStrictEqual(started);
					const [operation] = await operations(f);
					expect(operation).toMatchObject({
						cursor: 0,
						progressJson: '{"phase":"members"}'
					});
					const state = await runInDurableObject(
						fixtureWorkerServer(),
						async (instance) => {
							const context = instance.context;
							const proofs = context.db
								.select()
								.from(schema.resultPublicationMembers)
								.where(
									eq(
										schema.resultPublicationMembers.materialisationId,
										started.operationId
									)
								)
								.all();
							expect(proofs).toHaveLength(1);
							const original = proofs[0];
							if (original === undefined) {
								throw new Error('Missing result proof');
							}
							const accepted = await acceptedEnsureState(context, f);
							const cache = context.cacheRepository.require(unrelated.source);
							const row = context.db
								.select()
								.from(schema.narInfos)
								.where(eq(schema.narInfos.cacheId, cache.id))
								.get();
							if (row === undefined) {
								throw new Error('Missing unrelated accepted path');
							}
							const version = {
								cacheId: cache.id,
								cacheGeneration: cache.generation,
								storePathHash: row.storePathHash,
								generation: row.generation,
								storePath: row.storePath,
								narHash: row.narHash
							};
							const availability = new PublicationManifestAvailabilityStore(
								context.db
							);
							const snapshot = availability.snapshot(version);
							expect(snapshot.revision).toBe(original.availabilityRevision);
							const objects = new NarInfoObjectsService(context);
							const key = objects.objectKey(cache, row.storePathHash);
							expect(await context.env.BLOBS.head(key)).not.toBeNull();
							// Observe the real remote write with its durable intent already fenced.
							const remove = context.env.BLOBS.delete.bind(context.env.BLOBS);
							const batch = context.d1.batch.bind(context.d1);
							const remote =
								mutation === 'delete'
									? vi
											.spyOn(context.env.BLOBS, 'delete')
											.mockImplementationOnce(async (...arguments_) => {
												expect(availability.hasPending(version)).toBe(true);
												return remove(...arguments_);
											})
									: vi
											.spyOn(context.d1, 'batch')
											.mockImplementationOnce(async (...arguments_) => {
												expect(availability.hasPending(version)).toBe(true);
												return batch(...arguments_);
											});
							const begin = vi.spyOn(
								PublicationManifestAvailabilityStore.prototype,
								'begin'
							);
							try {
								await context.criticalSection(() =>
									mutation === 'delete'
										? objects.deleteNarInfoObject(cache, row.storePathHash)
										: new PathReadAuthorityService(context).revoke(cache, [row])
								);
								expect(remote).toHaveBeenCalled();
								expect(begin).toHaveReturnedWith(
									expect.objectContaining({
										...version,
										remotePending: true,
										revision: snapshot.revision + 1
									})
								);
							} finally {
								remote.mockRestore();
								begin.mockRestore();
							}
							expect(availability.snapshot(version).revision).toBe(
								snapshot.revision + 1
							);
							expect(availability.hasPending(version)).toBe(false);
							expect(
								availability.getIntent(snapshot.revision + 1)
							).toBeUndefined();
							if (mutation === 'delete') {
								expect(await context.env.BLOBS.head(key)).toBeNull();
							} else {
								expect(
									await context.d1
										.select()
										.from(d1Schema.pathReadRevocation)
										.where(
											eq(
												d1Schema.pathReadRevocation.cacheName,
												unrelated.source.name
											)
										)
										.get()
								).toMatchObject({
									storePathHash: row.storePathHash,
									generation: row.generation,
									isPending: true
								});
							}
							return { original, accepted };
						}
					);
					return { f, started, operation, ...state };
				}, fixtureWorkerServer());
				await restartTestServers();
				const completed = await withoutAlarmArming(async () => {
					const { f, started, original, operation, accepted } = observed;
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						instance.context.ctx.storage.sql.exec(
							`PRAGMA recursive_triggers=${isRecursive ? 'ON' : 'OFF'}`
						);
					});
					expect(await status(f, started.operationId)).toStrictEqual(started);
					// Result is portable ordinal zero: this must reuse its original proof.
					expect(await advance(f, started.operationId)).toStrictEqual(started);
					const [revisited] = await operations(f);
					expect(revisited?.cursor).toBe(1);
					const completed = await complete(f);
					expect(completed).toMatchObject({
						kind: 'complete',
						association: 'created',
						publication: {
							digest: f.publication.digest,
							memberCount: 2,
							result: { cache: f.destination }
						}
					});
					expect(await status(f, started.operationId)).toStrictEqual(completed);
					expect(f.publisher.publish).not.toHaveBeenCalled();
					const [receipt] = await operations(f);
					expect(receipt).toMatchObject({
						canonicalJson: operation?.canonicalJson,
						sourceJson: operation?.sourceJson,
						expiresAt: operation?.expiresAt,
						resultIdentityJson: operation?.resultIdentityJson,
						cursor: 2,
						state: 'complete'
					});
					await runInDurableObject(fixtureWorkerServer(), async (instance) => {
						const context = instance.context;
						expect(await acceptedEnsureState(context, f)).toStrictEqual(
							accepted
						);
						const proofs = context.db
							.select()
							.from(schema.resultPublicationMembers)
							.where(
								eq(
									schema.resultPublicationMembers.materialisationId,
									started.operationId
								)
							)
							.orderBy(schema.resultPublicationMembers.memberPath)
							.all();
						expect(proofs).toHaveLength(2);
						expect(proofs[0]).toStrictEqual(original);
						const cardinality = context.db
							.select()
							.from(schema.publicationManifestCardinalities)
							.where(
								and(
									eq(schema.publicationManifestCardinalities.kind, 'candidate'),
									eq(
										schema.publicationManifestCardinalities.id,
										started.operationId
									)
								)
							)
							.get();
						expect(cardinality).toStrictEqual({
							kind: 'candidate',
							id: started.operationId,
							memberCount: 2,
							valid: true
						});
						const cache = context.cacheRepository.require(f.destination);
						const members = new PublicationManifestRepository(
							context
						).selectedMembers(cache, completed.publication.result);
						expect(members?.members).toStrictEqual(proofs);
						expect(
							proofs.map((proof) => ({
								storePath: proof.memberPath,
								narHash: proof.memberNarHash,
								generation: proof.memberGeneration
							}))
						).toStrictEqual(
							accepted.narinfos
								.filter((row) => row.cacheId === cache.id)
								.map((row) => captureMember(row))
						);
						expect(proofs[1]?.availabilityRevision).toBe(
							original.availabilityRevision + 1
						);
						expect(
							context.db
								.select()
								.from(schema.resultPublications)
								.where(eq(schema.resultPublications.cacheId, cache.id))
								.get()
						).toMatchObject({
							complete: true,
							materialisationId: started.operationId,
							digest: f.publication.digest
						});
					});
					return completed;
				}, fixtureWorkerServer());
				await restartTestServers();
				expect(
					await status(observed.f, observed.started.operationId)
				).toStrictEqual(completed);
			});
		}
	}

	it('uses a warm O(1) certificate without member enumeration, probes or publisher work', async () => {
		const f = await fixture({ same: true, child: true });
		const probe = vi.spyOn(
			PublicationManifestAuthority.prototype,
			'requireServable'
		);
		const selected = vi.spyOn(
			PublicationManifestRepository.prototype,
			'selectedMembers'
		);
		const response = await ensure(f);
		expect(response.kind).toBe('complete');
		expect(f.publisher.admit).not.toHaveBeenCalled();
		expect(f.publisher.publish).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(selected).not.toHaveBeenCalled();
		const [operation] = await operations(f);
		if (operation === undefined) {
			throw new Error('No receipt');
		}
		expect(await status(f, operation.id)).toStrictEqual(response);
		expect(await ensure(f)).toStrictEqual(response);
		const replayedOperations = await operations(f);
		expect(replayedOperations[0]).toStrictEqual(operation);
	});

	it('stages bounded healthy destination proofs across caches, survives restart and keeps receipt/deadline sticky', async () => {
		const f = await fixture({ child: true });
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		const [original] = await operations(f);
		expect(await status(f, started.operationId)).toStrictEqual(started);
		expect(f.publisher.publish).not.toHaveBeenCalled();
		const advanced = await advance(f, started.operationId);
		expect(advanced.kind).toBe('pending');
		expect(f.publisher.publish).not.toHaveBeenCalled();
		await restartTestServers();
		const advancedAgain = await advance(f, started.operationId);
		expect(advancedAgain.kind).toBe('pending');
		expect(f.publisher.publish).not.toHaveBeenCalled();
		const response = await complete(f);
		expect(response).toMatchObject({
			kind: 'complete',
			association: 'created',
			publication: {
				digest: f.publication.digest,
				memberCount: 2,
				result: { cache: f.destination }
			}
		});
		const [receipt] = await operations(f);
		expect(receipt?.expiresAt).toBe(original?.expiresAt);
		const count = vi.mocked(f.publisher.publish).mock.calls.length;
		expect(await ensure(f)).toStrictEqual(response);
		expect(vi.mocked(f.publisher.publish).mock.calls).toHaveLength(count);
		const replayedOperations = await operations(f);
		expect(replayedOperations[0]).toStrictEqual(receipt);
	});

	it('supports a first destination solely through actual publication admission', async () => {
		const f = await fixture({ absent: true });
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			expect(
				instance.context.cacheRepository.resolve(f.destination)
			).toBeUndefined();
		});
		const completed = await complete(f);
		expect(completed.kind).toBe('complete');
		expect(f.publisher.admit).toHaveBeenCalledTimes(1);
	});

	it('rejects changed request payloads before source resolution', async () => {
		const f = await fixture({ same: true });
		await ensure(f);
		await expect(
			ensure(f, {
				...f.request,
				source: { ...f.publication, origin: 'legacy-selection' }
			})
		).rejects.toMatchObject({ code: 'PUBLICATION_IDEMPOTENCY_CONFLICT' });
	});

	it('does not confer private source authority from destination commit permission', async () => {
		const f = await fixture({ private: true, absent: true });
		await expect(ensure(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(f.publisher.admit).not.toHaveBeenCalled();
	});

	it('permits an independently authorised private view and fences its revision', async () => {
		const f = await fixture({ private: true });
		await setView(
			[{ kind: 'named', name: f.source.name }],
			'ensure-view',
			'private'
		);
		const selector = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const view = instance.context.db.select().from(schema.reuseViews).get();
				if (view === undefined) {
					throw new Error('Missing view');
				}
				return { view: view.name, expectedRevision: view.revision };
			}
		);
		f.grants = authorizationDetailsSchema.parse([
			...f.grants,
			{
				type: 'cupboard_view',
				view: selector.view,
				actions: ['view:content-read']
			}
		]);
		f.request = { ...f.request, sourceSelector: selector };
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		await setView(
			[{ kind: 'named', name: 'not-the-source' }],
			'ensure-view',
			'private'
		);
		await expect(advance(f, started.operationId)).rejects.toMatchObject({
			code: 'PUBLICATION_SCOPE_CHANGED'
		});
		expect(await status(f, started.operationId)).toMatchObject({
			kind: 'failed',
			reason: 'scope-changed'
		});
	});

	it('does not claim availability from a stale complete receipt', async () => {
		const f = await fixture({ same: true });
		await ensure(f);
		const [operation] = await operations(f);
		if (operation === undefined) {
			throw new Error('Missing receipt');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.update(schema.resultPublications)
				.set({ complete: false })
				.run()
		);
		expect(await status(f, operation.id)).toStrictEqual({
			kind: 'failed',
			reason: 'result-changed'
		});
		expect(f.publisher.publish).not.toHaveBeenCalled();
	});

	it('expires immutable work without status progression or deadline extension', async () => {
		const f = await fixture();
		await withoutAlarmArming(async () => {
			const started = await ensure(f);
			if (started.kind !== 'pending') {
				throw new Error('Expected pending');
			}
			await runInDurableObject(fixtureWorkerServer(), (instance) =>
				instance.context.db
					.update(schema.publicationManifestOperations)
					.set({ expiresAt: isoTimestamp(new Date(0)) })
					.where(
						eq(schema.publicationManifestOperations.id, started.operationId)
					)
					.run()
			);
			expect(await status(f, started.operationId)).toStrictEqual({
				kind: 'failed',
				reason: 'expired'
			});
			await expect(advance(f, started.operationId)).rejects.toMatchObject({
				code: 'GONE'
			});
			expect(f.publisher.publish).not.toHaveBeenCalled();
		}, fixtureWorkerServer());
	});

	it('invalidates pending candidate proofs when an accepted destination member changes', async () => {
		const f = await fixture({ child: true });
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		await advance(f, started.operationId);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			const hash = StorePath.hash(f.publication.result.storePath);
			instance.context.db
				.update(schema.narInfos)
				.set({ generation: narInfoGenerationSchema.parse(99) })
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, hash)
					)
				)
				.run();
			withRowBudget(() =>
				new PublicationManifestCleanup(instance.context.db).collect(
					isoTimestamp(new Date()),
					64
				)
			);
		});
		expect(await status(f, started.operationId)).toStrictEqual({
			kind: 'failed',
			reason: 'generation-conflict'
		});
		await expect(advance(f, started.operationId)).rejects.toMatchObject({
			code: 'CONFLICT'
		});
	});
	it('attaches only the exact result to an existing run root without renewing its retention', async () => {
		const f = await fixture({ child: true });
		const rootName = rootNameSchema.parse('run/test');
		const original = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const cache = instance.context.cacheRepository.require(f.destination);
				const timestamp = isoTimestamp(new Date());
				const expiresAt = isoTimestamp(new Date(Date.now() + 3_600_000));
				instance.context.db
					.insert(schema.retentionRoots)
					.values({
						cacheId: cache.id,
						name: rootName,
						createdAt: timestamp,
						updatedAt: timestamp,
						expiresAt
					})
					.run();
				return instance.context.db
					.select()
					.from(schema.retentionRoots)
					.where(eq(schema.retentionRoots.cacheId, cache.id))
					.get();
			}
		);
		f.request = { ...f.request, runRoot: rootName };
		expect(await complete(f)).toMatchObject({ kind: 'complete' });
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			expect(
				instance.context.db
					.select()
					.from(schema.retentionRoots)
					.where(eq(schema.retentionRoots.cacheId, cache.id))
					.get()
			).toStrictEqual(original);
			const targets = instance.context.db
				.select()
				.from(schema.retentionRootTargets)
				.where(eq(schema.retentionRootTargets.cacheId, cache.id))
				.all();
			expect(targets).toHaveLength(1);
			expect(targets[0]?.storePath).toBe(f.publication.result.storePath);
		});
	});

	it('requires root:attach separately and never creates an absent root or destination', async () => {
		const f = await fixture({ absent: true });
		f.request = { ...f.request, runRoot: rootNameSchema.parse('run/missing') };
		f.grants = authorizationDetailsSchema.parse([
			{
				type: 'cupboard_cache',
				cache: f.destination,
				actions: ['upload:commit']
			}
		]);
		await expect(ensure(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		f.grants = authorizationDetailsSchema.parse([
			{
				type: 'cupboard_cache',
				cache: f.destination,
				actions: ['upload:commit', 'root:attach'],
				root: 'run/'
			}
		]);
		await expect(ensure(f)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		expect(f.publisher.admit).not.toHaveBeenCalled();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			expect(
				instance.context.cacheRepository.resolve(f.destination)
			).toBeUndefined();
		});
	});

	it('repairs an incomplete association only to the same portable set and retires its old selection', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture({ child: true });
			await complete(f);
			const previous = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) => {
					const cache = instance.context.cacheRepository.require(f.destination);
					const row = instance.context.db
						.select()
						.from(schema.resultPublications)
						.where(eq(schema.resultPublications.cacheId, cache.id))
						.get();
					instance.context.db
						.update(schema.resultPublications)
						.set({ complete: false })
						.where(eq(schema.resultPublications.cacheId, cache.id))
						.run();
					return row;
				}
			);
			f.request = {
				...f.request,
				requestId: createPublicationRequestId()
			};
			expect(await complete(f)).toMatchObject({
				kind: 'complete',
				association: 'existing',
				publication: { digest: f.publication.digest, memberCount: 2 }
			});
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(f.destination);
				const row = instance.context.db
					.select()
					.from(schema.resultPublications)
					.where(eq(schema.resultPublications.cacheId, cache.id))
					.get();
				expect(row?.materialisationId).not.toBe(previous?.materialisationId);
				expect(row?.digest).toBe(previous?.digest);
				expect(row?.origin).toBe(previous?.origin);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestRetirements)
						.where(
							eq(
								schema.publicationManifestRetirements.materialisationId,
								previous?.materialisationId ?? ''
							)
						)
						.get()?.digest
				).toBe(f.publication.digest);
			});
		}, fixtureWorkerServer());
	});

	it('leaves durable normal pending work and cursor/deadline unchanged on retry', async () => {
		const f = await fixture();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			instance.context.db
				.delete(schema.narInfos)
				.where(eq(schema.narInfos.cacheId, cache.id))
				.run();
			withRowBudget(() =>
				new PublicationManifestCleanup(instance.context.db).collect(
					isoTimestamp(new Date()),
					64
				)
			);
		});
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		const original = await operations(f);
		vi.mocked(f.publisher.publish).mockResolvedValueOnce({ kind: 'pending' });
		expect(await advance(f, started.operationId)).toStrictEqual(started);
		expect(await operations(f)).toStrictEqual(original);
		expect(await complete(f)).toMatchObject({ kind: 'complete' });
	});

	it('does not swallow provider failures or extend the recovery window', async () => {
		const f = await fixture();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			instance.context.db
				.delete(schema.narInfos)
				.where(eq(schema.narInfos.cacheId, cache.id))
				.run();
			withRowBudget(() =>
				new PublicationManifestCleanup(instance.context.db).collect(
					isoTimestamp(new Date()),
					64
				)
			);
		});
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		const original = await operations(f);
		vi.mocked(f.publisher.publish).mockRejectedValueOnce(
			new Error('provider unavailable')
		);
		await expect(advance(f, started.operationId)).rejects.toThrow(
			'provider unavailable'
		);
		expect(await operations(f)).toStrictEqual(original);
	});

	it('rejects source result revocation on warm replay and observes failure without object work', async () => {
		const f = await fixture({ same: true });
		await ensure(f);
		const [operation] = await operations(f);
		if (operation === undefined) {
			throw new Error('Expected receipt');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			new PathReadAuthorityService(instance.context).revoke(
				instance.context.cacheRepository.require(f.source),
				[
					{
						storePathHash: StorePath.hash(f.publication.result.storePath),
						generation: f.publication.result.generation
					}
				]
			)
		);
		const probe = vi.spyOn(
			PublicationManifestAuthority.prototype,
			'requireServable'
		);
		expect(await status(f, operation.id)).toStrictEqual({
			kind: 'failed',
			reason: 'result-changed'
		});
		await expect(ensure(f)).rejects.toMatchObject({
			code: 'PUBLICATION_RESULT_CHANGED'
		});
		expect(probe).not.toHaveBeenCalled();
	});

	it('rejects destination generation changes before any publication work', async () => {
		const f = await fixture();
		f.request = publicationEnsureRequestSchema.parse({
			...f.request,
			expectedDestinationGeneration: 9
		});
		await expect(ensure(f)).rejects.toMatchObject({
			code: 'PUBLICATION_GENERATION_CONFLICT'
		});
		expect(f.publisher.admit).not.toHaveBeenCalled();
	});

	it('reports destination NAR divergence explicitly instead of replacing an accepted result', async () => {
		const f = await fixture();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			instance.context.db
				.update(schema.narInfos)
				.set({ narHash: nixSha256HashSchema.parse('sha256:' + '0'.repeat(52)) })
				.where(eq(schema.narInfos.cacheId, cache.id))
				.run();
		});
		await expect(ensure(f)).rejects.toMatchObject({
			code: 'PUBLICATION_DIVERGENCE'
		});
		expect(f.publisher.admit).not.toHaveBeenCalled();
	});

	it('keeps parallel candidates isolated and lets only one final transaction select the materialisation', async () => {
		const first = await fixture({ child: true });
		const second = {
			...first,
			request: {
				...first.request,
				requestId: createPublicationRequestId()
			}
		};
		const a = await ensure(first);
		const b = await ensure(second);
		if (a.kind !== 'pending' || b.kind !== 'pending') {
			throw new Error('Expected candidates');
		}
		for (let step = 0; step < 3; step += 1) {
			await advance(first, a.operationId);
			await advance(second, b.operationId);
		}
		const responses = await Promise.all([
			advance(first, a.operationId),
			advance(second, b.operationId)
		]);
		expect(responses.map((response) => response.kind)).toStrictEqual([
			'complete',
			'complete'
		]);
		expect(
			responses.filter(
				(response) =>
					response.kind === 'complete' && response.association === 'created'
			)
		).toHaveLength(1);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(first.destination);
			const association = instance.context.db
				.select()
				.from(schema.resultPublications)
				.where(eq(schema.resultPublications.cacheId, cache.id))
				.get();
			expect([a.operationId, b.operationId]).toContain(
				association?.materialisationId
			);
			const proofs = instance.context.db
				.select()
				.from(schema.resultPublicationMembers)
				.where(eq(schema.resultPublicationMembers.cacheId, cache.id))
				.all();
			expect(proofs).toHaveLength(4);
			expect(
				proofs.filter(
					(proof) => proof.materialisationId === association?.materialisationId
				)
			).toHaveLength(2);
		});
	});

	it('revisits the marked owner once at finalisation and never roots private candidates', async () => {
		const f = await fixture({ child: true });
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		for (let step = 0; step < 3; step += 1) {
			await advance(f, started.operationId);
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			instance.context.db
				.insert(schema.garbageCollectionScans)
				.values({ cacheId: cache.id, phase: 'collect' })
				.run();
			instance.context.db
				.insert(schema.garbageCollectionMarks)
				.values({
					cacheId: cache.id,
					storePathHash: StorePath.hash(f.publication.result.storePath)
				})
				.run();
			expect(
				instance.context.db
					.select()
					.from(schema.garbageCollectionFrontier)
					.where(eq(schema.garbageCollectionFrontier.cacheId, cache.id))
					.all()
			).toStrictEqual([]);
		});
		expect(await advance(f, started.operationId)).toMatchObject({
			kind: 'complete'
		});
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			const frontier = instance.context.db
				.select()
				.from(schema.garbageCollectionFrontier)
				.where(eq(schema.garbageCollectionFrontier.cacheId, cache.id))
				.all();
			expect(frontier).toStrictEqual([
				{
					cacheId: cache.id,
					storePathHash: StorePath.hash(f.publication.result.storePath)
				}
			]);
			expect(
				instance.context.db
					.select()
					.from(schema.retentionRootTargets)
					.where(eq(schema.retentionRootTargets.cacheId, cache.id))
					.all()
			).toStrictEqual([]);
		});
	});

	it('prunes one expired receipt without deleting its live selected proof', async () => {
		const f = await fixture();
		const response = await complete(f);
		const [operation] = await operations(f);
		if (operation === undefined) {
			throw new Error('Expected receipt');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			instance.context.db
				.update(schema.publicationManifestOperations)
				.set({ expiresAt: isoTimestamp(new Date(0)) })
				.where(eq(schema.publicationManifestOperations.id, operation.id))
				.run();
			const cleanup = new PublicationManifestCleanup(instance.context.db);
			withRowBudget(() => cleanup.collect(isoTimestamp(new Date()), 1));
			expect(
				instance.context.db
					.select()
					.from(schema.publicationManifestOperations)
					.where(eq(schema.publicationManifestOperations.id, operation.id))
					.get()
			).toBeUndefined();

			const cache = instance.context.cacheRepository.require(f.destination);
			expect(
				new PublicationManifestRepository(instance.context).association(
					cache,
					response.publication.result
				)?.complete
			).toBe(true);
			expect(
				new PublicationManifestRepository(instance.context).selectedMembers(
					cache,
					response.publication.result
				)?.members
			).toHaveLength(1);
		});
	});
	it('observes destination divergence and durably fails continuation without publisher work', async () => {
		const f = await fixture();
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			instance.context.db
				.update(schema.narInfos)
				.set({ narHash: nixSha256HashSchema.parse('sha256:' + '0'.repeat(52)) })
				.where(eq(schema.narInfos.cacheId, cache.id))
				.run();
		});
		expect(await status(f, started.operationId)).toStrictEqual({
			kind: 'failed',
			reason: 'divergence'
		});
		await expect(advance(f, started.operationId)).rejects.toMatchObject({
			code: 'PUBLICATION_DIVERGENCE'
		});
		const receipts = await operations(f);
		expect(receipts[0]?.state).toBe('failed');
		expect(f.publisher.publish).not.toHaveBeenCalled();
	});

	it('rechecks direct private source permissions when work resumes', async () => {
		const f = await fixture({ private: true });
		const destinationGrants = f.grants;
		f.grants = authorizationDetailsSchema.parse([
			...f.grants,
			{
				type: 'cupboard_cache',
				cache: f.source,
				actions: ['cache:content-read']
			}
		]);
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		f.grants = destinationGrants;
		await expect(advance(f, started.operationId)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(status(f, started.operationId)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const receipts = await operations(f);
		expect(receipts[0]?.state).toBe('pending');
		expect(f.publisher.publish).not.toHaveBeenCalled();
	});

	it('rejects members missing from both source and destination rather than treating captured metadata as complete', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture({ child: true });
			const started = await ensure(f);
			if (started.kind !== 'pending') {
				throw new Error('Expected pending');
			}
			await advance(f, started.operationId);
			await advance(f, started.operationId);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(f.source);
				const childHash = storePathHashSchema.parse(
					'00000000000000000000000000000002'
				);
				instance.context.db
					.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, childHash)
						)
					)
					.run();
			});
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(f.destination);
				const childHash = storePathHashSchema.parse(
					'00000000000000000000000000000002'
				);
				instance.context.db
					.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, childHash)
						)
					)
					.run();
			});
			await expect(advance(f, started.operationId)).rejects.toMatchObject({
				code: 'SERVICE_UNAVAILABLE'
			});
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				withRowBudget(() =>
					new PublicationManifestCleanup(instance.context.db).collect(
						isoTimestamp(new Date()),
						64
					)
				);
			});
			await expect(advance(f, started.operationId)).rejects.toMatchObject({
				code: 'PUBLICATION_RESULT_CHANGED'
			});
			expect(await status(f, started.operationId)).toStrictEqual({
				kind: 'failed',
				reason: 'result-changed'
			});
		}, fixtureWorkerServer());
	});

	it('validates durable progress before resuming publication', async () => {
		const f = await fixture();
		const started = await ensure(f);
		if (started.kind !== 'pending') {
			throw new Error('Expected pending');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.update(schema.publicationManifestOperations)
				.set({ progressJson: '{"phase":"unknown"}' })
				.where(eq(schema.publicationManifestOperations.id, started.operationId))
				.run()
		);
		await expect(advance(f, started.operationId)).rejects.toThrow();
		expect(f.publisher.publish).not.toHaveBeenCalled();
	});
	it('does not replay a complete cross-cache receipt after its destination result is revoked', async () => {
		const f = await fixture();
		const response = await complete(f);
		const [operation] = await operations(f);
		if (operation === undefined) {
			throw new Error('Expected receipt');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			new PathReadAuthorityService(instance.context).revoke(
				instance.context.cacheRepository.require(f.destination),
				[
					{
						storePathHash: StorePath.hash(
							response.publication.result.storePath
						),
						generation: response.publication.result.generation
					}
				]
			)
		);
		expect(await status(f, operation.id)).toStrictEqual({
			kind: 'failed',
			reason: 'result-changed'
		});
		await expect(ensure(f)).rejects.toMatchObject({
			code: 'PUBLICATION_RESULT_CHANGED'
		});
	});
	it('never repairs an existing desired association to a different portable membership set', async () => {
		const f = await fixture({ child: true });
		await complete(f);
		const alternative = await fixture({ same: true, narSeed: f.seed });
		expect(alternative.publication.result.narHash).toBe(
			f.publication.result.narHash
		);
		expect(alternative.publication.digest).not.toBe(f.publication.digest);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			instance.context.db
				.update(schema.resultPublications)
				.set({ complete: false })
				.where(eq(schema.resultPublications.cacheId, cache.id))
				.run();
		});
		const request = {
			...f.request,
			requestId: createPublicationRequestId(),
			source: alternative.publication
		};
		await expect(ensure(f, request)).rejects.toMatchObject({
			code: 'PUBLICATION_DIVERGENCE'
		});
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.destination);
			const association = instance.context.db
				.select()
				.from(schema.resultPublications)
				.where(eq(schema.resultPublications.cacheId, cache.id))
				.get();
			expect(association?.digest).toBe(f.publication.digest);
			expect(association?.complete).toBe(false);
		});
	});
	it('keeps replay identity independent of cache-scope property insertion order', async () => {
		const f = await fixture({ same: true });
		const response = await ensure(f);
		const original = await operations(f);
		const replayed = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) =>
				new PublicationManifestEnsureService(
					instance.context,
					f.publisher
				).ensure(
					{ name: f.destination.name, kind: 'named' },
					f.grants,
					f.request
				)
		);
		expect(replayed).toStrictEqual(response);
		expect(await operations(f)).toStrictEqual(original);
	});
	it('never interprets a failed operation payload as a complete receipt', async () => {
		const f = await fixture({ same: true });
		const response = await ensure(f);
		const [operation] = await operations(f);
		if (operation === undefined) {
			throw new Error('Expected receipt');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			instance.context.db
				.update(schema.publicationManifestOperations)
				.set({ state: 'failed', failureJson: JSON.stringify(response) })
				.where(eq(schema.publicationManifestOperations.id, operation.id))
				.run();
		});
		await expect(status(f, operation.id)).rejects.toMatchObject({
			code: 'CONFLICT'
		});
	});
});

function captureMember(
	row: Pick<
		typeof schema.narInfos.$inferSelect,
		'storePath' | 'narHash' | 'generation'
	>
) {
	return {
		storePath: row.storePath,
		narHash: row.narHash,
		generation: row.generation
	};
}

/**
Synthetic reverse fan-in setup, outside every measured invocation.
*/
function seedAvailabilityFanIn(
	context: ServerContext,
	f: Fixture,
	count: number
) {
	const cache = context.cacheRepository.require(f.source);
	const row = context.db
		.select()
		.from(schema.narInfos)
		.where(eq(schema.narInfos.cacheId, cache.id))
		.get();
	if (row === undefined) {
		throw new Error('Missing accepted result');
	}
	// Synthetic selected owners measure raw reverse fan-in, not admission.
	context.db
		.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i+1 < ${count})
					INSERT INTO result_publication(cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,origin,complete,materialisation_id)
					SELECT ${cache.id},${cache.generation},printf('%032d',i+100),printf('/nix/store/%032d-owner',i+100),${row.generation},${row.narHash},${f.publication.digest},'build-selection',1,printf('synthetic-%d-%06d',${cache.id},i) FROM n`);
	context.db
		.run(sql`INSERT INTO result_publication_member(cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation)
					SELECT cache_id,cache_generation,result_hash,result_generation,materialisation_id,${row.storePathHash},${row.storePath},${row.narHash},${row.generation}
					FROM result_publication WHERE cache_id=${cache.id} AND materialisation_id LIKE 'synthetic-%'`);
	return { cache, row };
}

describe('publication availability bounded integration', () => {
	it('drains 130 old proofs without poisoning a fresh same-version capture or an unrelated warm receipt', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture({ same: true, child: true });
			await committedPath(`${f.seed}-third`, f.source, {
				storePathHash: '00000000000000000000000000000003',
				name: 'third'
			});
			const childHash = storePathHashSchema.parse(
				'00000000000000000000000000000002'
			);
			const thirdHash = storePathHashSchema.parse(
				'00000000000000000000000000000003'
			);
			const childRequest = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance) => {
					const cache = instance.context.cacheRepository.require(f.source);
					const child = instance.context.db
						.select()
						.from(schema.narInfos)
						.where(
							and(
								eq(schema.narInfos.cacheId, cache.id),
								eq(schema.narInfos.storePathHash, childHash)
							)
						)
						.get();
					if (child === undefined) {
						throw new Error('Missing child');
					}
					const capture = new PublicationManifestCaptureService(
						instance.context
					);
					const started = await capture.captureBegin(f.source, f.grants, {
						requestId: createPublicationRequestId(),
						origin: 'build-selection',
						expectedCacheGeneration: cache.generation,
						memberCount: 1,
						result: captureMember(child)
					});
					if (started.kind !== 'staging') {
						throw new Error('Expected child capture');
					}
					await capture.capturePage(f.source, f.grants, {
						operationId: started.operationId,
						page: 0,
						members: [captureMember(child)]
					});
					for (let step = 0; step < 12; step += 1) {
						const sealed = await capture.captureSeal(f.source, f.grants, {
							operationId: started.operationId
						});
						if (sealed.kind === 'captured') {
							return publicationEnsureRequestSchema.parse({
								...f.request,
								requestId: createPublicationRequestId(),
								source: sealed.publication
							});
						}
					}
					throw new Error('Child capture did not finish');
				}
			);
			const healthyReceipt = await ensure(f, childRequest);
			expect(healthyReceipt.kind).toBe('complete');
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const { cache, row } = seedAvailabilityFanIn(instance.context, f, 130);
				const availability = new PublicationManifestAvailabilityStore(
					instance.context.db
				);
				await instance.context.criticalSection(() =>
					new NarInfoObjectsService(instance.context).deleteNarInfoObject(
						cache,
						row.storePathHash
					)
				);
				const intent = availability.nextIntent(false);
				if (intent === undefined) {
					throw new Error('Missing bounded work');
				}
				const repository = new PublicationManifestRepository(instance.context);
				expect(
					repository.association(cache, childRequest.source.result)?.complete
				).toBe(false);
				const third = instance.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, thirdHash)
						)
					)
					.get();
				if (third === undefined) {
					throw new Error('Missing third result');
				}
				const capture = new PublicationManifestCaptureService(instance.context);
				const started = await capture.captureBegin(f.source, f.grants, {
					requestId: createPublicationRequestId(),
					origin: 'build-selection',
					expectedCacheGeneration: cache.generation,
					memberCount: 2,
					result: captureMember(third)
				});
				if (started.kind !== 'staging') {
					throw new Error('Expected fresh capture');
				}
				await capture.capturePage(f.source, f.grants, {
					operationId: started.operationId,
					page: 0,
					members: [captureMember(third), captureMember(row)]
				});
				const proof = instance.context.db
					.select()
					.from(schema.resultPublicationMembers)
					.where(
						and(
							eq(
								schema.resultPublicationMembers.materialisationId,
								started.operationId
							),
							eq(schema.resultPublicationMembers.memberPath, row.storePath)
						)
					)
					.get();
				expect(proof?.availabilityRevision).toBe(intent.revision);
				withRowBudget(() =>
					new PublicationManifestCleanup(instance.context.db).collect(
						isoTimestamp(new Date()),
						64
					)
				);
				expect(availability.getIntent(intent.revision)).toBeUndefined();
				expect(
					repository.association(cache, childRequest.source.result)?.complete
				).toBe(true);
				let isCaptured = false;
				for (let step = 0; step < 12; step += 1) {
					const sealed = await capture.captureSeal(f.source, f.grants, {
						operationId: started.operationId
					});
					if (sealed.kind === 'captured') {
						isCaptured = true;
						break;
					}
				}
				expect(isCaptured).toBe(true);
			});
			const probe = vi.spyOn(
				PublicationManifestAuthority.prototype,
				'requireServable'
			);
			try {
				const replayed = await ensure(f, childRequest);
				expect(replayed.kind).toBe('complete');
				expect(probe).not.toHaveBeenCalled();
			} finally {
				probe.mockRestore();
			}
		}, fixtureWorkerServer());
	});

	it('bounds real revocation and cleanup reverse pages at fan-in 128 and 100000, including an exhausted shared budget', async () => {
		await withoutAlarmArming(async () => {
			const costs: {
				remaining: boolean;
				rowsRead: number;
				rowsWritten: number;
			}[] = [];
			for (const count of [128, 100_000]) {
				const f = await fixture({ same: true });
				await ensure(f);
				await runInDurableObject(fixtureWorkerServer(), async (instance) => {
					const { cache, row } = seedAvailabilityFanIn(
						instance.context,
						f,
						count
					);
					const availability = new PublicationManifestAvailabilityStore(
						instance.context.db
					);
					await new PathReadAuthorityService(instance.context).revoke(cache, [
						row
					]);
					const intent = availability.nextIntent(false);
					if (intent === undefined) {
						throw new Error('Missing bounded continuation');
					}
					const invalidated = () =>
						instance.context.db.all<{ count: number }>(
							sql`SELECT count(*) AS count FROM result_publication WHERE cache_id=${cache.id} AND complete=0`
						)[0]?.count;
					expect(invalidated()).toBe(64);
					const cleanup = new PublicationManifestCleanup(instance.context.db);
					withRowBudget(() => {
						instance.context.db
							.select()
							.from(schema.publicationManifestAvailabilityClock)
							.all();
						const now = isoTimestamp(new Date());
						const hasMore = cleanup.collect(now, 64);
						expect(hasMore).toBe(true);
					}, 1);
					expect(
						availability.getIntent(intent.revision)?.cursorMaterialisationId
					).toBe(intent.cursorMaterialisationId);
					expect(invalidated()).toBe(64);
					costs.push(
						withRowBudget(() => {
							const isRemaining = cleanup.collect(isoTimestamp(new Date()), 64);
							const meter = currentRowBudgetMeter();
							if (meter === undefined) {
								throw new Error('Missing meter');
							}
							meter.recordOutstanding();
							return {
								remaining: isRemaining,
								rowsRead: meter.rowsRead,
								rowsWritten: meter.rowsWritten
							};
						}, 1)
					);
					expect(invalidated()).toBe(128);
					if (count !== 128) {
						return;
					}

					withRowBudget(() => cleanup.collect(isoTimestamp(new Date()), 64));
					expect(availability.getIntent(intent.revision)).toBeUndefined();
				});
			}
			expect(costs[0]).toEqual(costs[1]);
			expect(costs[0]?.rowsRead).toBeLessThan(1000);
			expect(costs[0]?.rowsWritten).toBeLessThan(300);
		}, fixtureWorkerServer());
	});
});
