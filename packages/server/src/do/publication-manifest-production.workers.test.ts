import { rootLogger } from '@cupboard/logger';
import {
	cacheGenerationSchema,
	type CacheScope,
	graceSecondsSchema,
	nixSha256HashSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import {
	publicationCleanupMarginMs,
	publicationIdentity
} from '@cupboard/protocol/publication';
import {
	createPublicationRequestId,
	publicationCaptureBeginResponseSchema,
	publicationCaptureSealResponseSchema,
	publicationEnsureRequestSchema,
	publicationEnsureResponseSchema,
	publicationLookupResponseSchema,
	publicationStatusResponseSchema
} from '@cupboard/protocol/publication-manifests';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	acceptCapabilitiesHeader,
	publicationCapability,
	uploadCapabilitiesHeader,
	uploadPathNegotiationSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { pushIdExpiresAtSeconds } from '../blob/push-id.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narObjectKey } from '../http/http.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import { testPushIdFor } from '../test-support.ts';
import {
	authorisedWorkerFetch,
	defaultCache,
	fixtureWorkerServer,
	handlerFetch,
	initialiseViaWorker,
	issueWorkerSignedToken,
	namedCache,
	putWorkerTestCache,
	resetTestServer,
	restartTestServers
} from '../test-support.ts';
import { verificationOf, withoutAlarmArming } from '../test-support.ts';

import { CacheCreationDefaultsService } from './cache-creation-defaults-service.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import { PublicationManifestAuthority } from './publication-manifest-authority.ts';
import { PublicationManifestAvailabilityStore } from './publication-manifest-availability-store.ts';
import { PublicationManifestCleanup } from './publication-manifest-cleanup.ts';
import { PublicationManifestEnsureService } from './publication-manifest-ensure.ts';
import {
	ensureMemberAdmissionSchema,
	ProductionPublicationManifestPublisher
} from './publication-manifest-production.ts';
import { PublicationStore } from './publication-store.ts';
import { RetentionService } from './retention-service.ts';
import { ReuseAuthority } from './reuse-authority.ts';
import { committedPath, setView } from './reuse-view-read.test-support.ts';
import { withRowBudget } from './row-budget.ts';
import { UploadsService } from './uploads-service.ts';
import { WorkSequenceService } from './work-sequence-service.ts';

const sequence = { next: 0 };
const sqlNull: unknown = expect.toSatisfy((value: unknown) => value === null);
function prefix(cache: CacheScope) {
	return cache.kind === 'default' ? '' : `/cache/${cache.name}`;
}
function gatewayFetch(path: string, token: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);
	return handlerFetch(`/t/${fixtureTenant}${path}`, { ...init, headers });
}

async function call(
	cache: CacheScope,
	suffix: string,
	token: string,
	body?: unknown,
	method = 'POST'
) {
	return gatewayFetch(`${prefix(cache)}/publication-results${suffix}`, token, {
		method,
		...(body !== undefined && {
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' }
		})
	});
}
async function fixture(
	sourceInput?: CacheScope,
	access: 'public' | 'private' = 'public',
	memberCount = 2
) {
	sequence.next += 1;
	const source = sourceInput ?? namedCache(`source-${String(sequence.next)}`);
	const token = await initialiseViaWorker();
	const result = await committedPath(
		`production-${String(sequence.next)}`,
		source,
		{
			access,
			storePathHash: String(sequence.next * 1000 + 1).padStart(32, '0'),
			name: 'result'
		}
	);
	const child = await committedPath(
		`production-child-${String(sequence.next)}`,
		source,
		{
			access,
			storePathHash: String(sequence.next * 1000 + 2).padStart(32, '0'),
			name: 'child'
		}
	);
	const paths = [result, child];
	for (let index = 2; index < memberCount; index += 1) {
		paths.push(
			await committedPath(
				`production-extra-${String(sequence.next)}-${String(index)}`,
				source,
				{
					access,
					storePathHash: String(sequence.next * 1000 + index + 1).padStart(
						32,
						'0'
					),
					name: 'member'
				}
			)
		);
	}
	const versions = await runInDurableObject(fixtureWorkerServer(), (instance) =>
		instance.context.db
			.select()
			.from(schema.narInfos)
			.where(
				eq(
					schema.narInfos.cacheId,
					instance.context.cacheRepository.require(source).id
				)
			)
			.all()
	);
	const resultVersion = versions.find(
		(row) => row.storePath === result.storePath
	);
	const childVersion = versions.find(
		(row) => row.storePath === child.storePath
	);
	if (resultVersion === undefined || childVersion === undefined) {
		throw new Error('Missing source');
	}

	const beginResponse = await call(source, '/captures', token, {
		result: {
			storePath: result.storePath,
			narHash: result.narHash,
			generation: resultVersion.generation
		},
		requestId: createPublicationRequestId(),
		expectedCacheGeneration: 1,
		origin: 'build-selection',
		memberCount
	});
	expect(beginResponse.status).toBe(200);
	const begin = publicationCaptureBeginResponseSchema.parse(
		await beginResponse.json()
	);
	if (begin.kind !== 'staging') {
		throw new Error('Expected capture');
	}
	const observed = await call(
		source,
		`/operations/${begin.operationId}`,
		token,
		undefined,
		'GET'
	);
	expect(observed.status).toBe(200);
	expect(
		publicationStatusResponseSchema.parse(await observed.json()).kind
	).toBe('pending');
	const members = paths.map((path) => {
		const version = versions.find((row) => row.storePath === path.storePath);
		if (version === undefined) {
			throw new Error('Missing source member');
		}
		return {
			storePath: version.storePath,
			narHash: version.narHash,
			generation: version.generation
		};
	});
	for (let page = 0; page * 64 < members.length; page += 1) {
		const response = await call(
			source,
			`/captures/${begin.operationId}/pages/${String(page)}`,
			token,
			{ members: members.slice(page * 64, (page + 1) * 64) },
			'PUT'
		);
		expect(response.status).toBe(200);
	}

	for (let step = 0; step < 12; step += 1) {
		const sealedResponse = await call(
			source,
			`/captures/${begin.operationId}/seal`,
			token,
			{}
		);
		expect(sealedResponse.status).toBe(200);
		const sealed = publicationCaptureSealResponseSchema.parse(
			await sealedResponse.json()
		);
		if (sealed.kind === 'captured') {
			return {
				token,
				source,
				result,
				child,
				request: publicationEnsureRequestSchema.parse({
					requestId: createPublicationRequestId(),
					source: sealed.publication,
					expectedDestinationGeneration: 1
				})
			};
		}
	}
	throw new Error('Capture did not converge');
}

async function complete(
	destination: CacheScope,
	f: Awaited<ReturnType<typeof fixture>>
) {
	for (let step = 0; step < 100; step += 1) {
		const response = await call(destination, '/ensure', f.token, f.request);
		expect(response.status, await response.clone().text()).toBe(200);
		const result = publicationEnsureResponseSchema.parse(await response.json());
		if (result.kind === 'complete') {
			return result;
		}
		await verifyTenant(
			rootLogger(),
			env,
			new NarReadBufferPool(),
			fixtureTenant
		);
	}

	throw new Error('Ensure did not converge');
}

beforeEach(async () => {
	await resetTestServer();
	vi.setSystemTime(vi.getRealSystemTime());
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('production publication manifest binding', () => {
	it.each(['completion', 'expiry'] as const)(
		'protects an absent destination during pre-bind verification until %s',
		async (release) => {
			await withoutAlarmArming(async () => {
				const f = await fixture();
				const destination = namedCache(`pre-bind-${release}`);
				const sourceRow = await runInDurableObject(
					fixtureWorkerServer(),
					async (instance) => {
						expect(
							instance.context.cacheRepository.resolve(destination)
						).toBeUndefined();
						await new CacheCreationDefaultsService(instance.context).set({
							grace: {
								kind: 'duration',
								graceSeconds: graceSecondsSchema.parse(0)
							}
						});
						const source = instance.context.cacheRepository.require(f.source);
						const hash = StorePath.hash(f.result.storePath);
						const row = instance.context.db
							.select()
							.from(schema.narInfos)
							.where(
								and(
									eq(schema.narInfos.cacheId, source.id),
									eq(schema.narInfos.storePathHash, hash)
								)
							)
							.get();
						if (row === undefined) {
							throw new Error('Missing committed source result');
						}
						return row;
					}
				);
				const snapshot = () =>
					runInDurableObject(fixtureWorkerServer(), async (instance) => {
						const database = instance.context.db;
						const cache = instance.context.cacheRepository.require(destination);
						return {
							cache,
							admissions: database
								.select()
								.from(schema.publicationManifestAdmissions)
								.where(
									eq(
										schema.publicationManifestAdmissions.destinationName,
										destination.name
									)
								)
								.all(),
							mappings: database
								.select()
								.from(schema.publicationManifestOperationPages)
								.all()
								.filter(
									(row) =>
										database
											.select()
											.from(schema.publicationManifestAdmissions)
											.where(
												eq(
													schema.publicationManifestAdmissions.operationId,
													row.operationId
												)
											)
											.get()?.destinationName === destination.name
								),
							ordinary: database
								.select()
								.from(schema.publicationOperations)
								.where(eq(schema.publicationOperations.cacheId, cache.id))
								.all(),
							pending: database
								.select()
								.from(schema.pendingUploads)
								.where(eq(schema.pendingUploads.cacheId, cache.id))
								.all(),
							holds: database
								.select()
								.from(schema.publicationManifestWorkHolds)
								.where(
									eq(schema.publicationManifestWorkHolds.cacheId, cache.id)
								)
								.all(),
							rows: database
								.select()
								.from(schema.narInfos)
								.where(eq(schema.narInfos.cacheId, cache.id))
								.all(),
							receipts: database
								.select()
								.from(schema.publicationManifestOperations)
								.where(
									eq(schema.publicationManifestOperations.cacheId, cache.id)
								)
								.all(),
							associations: database
								.select()
								.from(schema.resultPublications)
								.where(eq(schema.resultPublications.cacheId, cache.id))
								.all(),
							roots: database
								.select()
								.from(schema.retentionRootTargets)
								.where(eq(schema.retentionRootTargets.cacheId, cache.id))
								.all(),
							grace: database
								.select()
								.from(schema.retentionGrace)
								.where(eq(schema.retentionGrace.cacheId, cache.id))
								.all(),
							references: await instance.context.d1
								.select()
								.from(d1Schema.blobReference)
								.where(
									and(
										eq(d1Schema.blobReference.tenant, fixtureTenant),
										eq(d1Schema.blobReference.cacheName, destination.name)
									)
								)
								.all(),
							usage: await instance.context.d1
								.select()
								.from(d1Schema.tenantUsage)
								.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
								.get()
						};
					});
				const gc = async () => {
					const token = await initialiseViaWorker();
					const response = await authorisedWorkerFetch(
						`${prefix(destination)}/gc`,
						token,
						{ method: 'POST' }
					);
					expect(response.status).toBe(200);
					// Drain normal inheritance/deletion continuations as separate invocations.
					for (let pass = 0; pass < 3; pass += 1) {
						await runInDurableObject(fixtureWorkerServer(), (instance) =>
							instance.alarm()
						);
					}
				};
				const descriptor:
					| TypedPropertyDescriptor<UploadsService['admitPublication']>
					| undefined = Object.getOwnPropertyDescriptor(
					UploadsService.prototype,
					'admitPublication'
				);
				const original = descriptor?.value;
				if (original === undefined) {
					throw new Error('Missing ordinary admission');
				}
				let initialUsage: Awaited<ReturnType<typeof snapshot>>['usage'];
				const spy = vi
					.spyOn(UploadsService.prototype, 'admitPublication')
					.mockImplementationOnce(async function (
						this: UploadsService,
						...arguments_
					) {
						const { pin, sequence, blob } = await runInDurableObject(
							fixtureWorkerServer(),
							async (instance) => {
								expect(
									instance.context.cacheRepository.resolve(destination)
								).toBeUndefined();
								return {
									pin: instance.context.db
										.select()
										.from(schema.publicationManifestAdmissions)
										.where(
											eq(
												schema.publicationManifestAdmissions.operationId,
												arguments_[5] ?? ''
											)
										)
										.get(),
									sequence: new WorkSequenceService(
										instance.context.db
									).current(),
									blob: await instance.context.d1
										.select()
										.from(d1Schema.blobState)
										.where(
											eq(
												d1Schema.blobState.narHash,
												arguments_[2].metadata.narHash
											)
										)
										.get()
								};
							}
						);
						if (pin === undefined || blob === undefined) {
							throw new Error(
								'Missing real manifest admission or accepted source blob'
							);
						}
						const expiresAtMs =
							Math.floor((Date.now() + 86_400_000) / 1000) * 1000;
						expect(pin).toEqual({
							operationId: pin.operationId,
							destinationKind: destination.kind,
							destinationName: destination.name,
							cacheId: sqlNull,
							cacheGeneration: f.request.expectedDestinationGeneration,
							canonicalJson: JSON.stringify(f.request),
							pushId: pin.pushId,
							expiresAt: new Date(expiresAtMs).toISOString(),
							pruneAfter: new Date(
								expiresAtMs + publicationCleanupMarginMs
							).toISOString()
						});
						const identity = await publicationIdentity({
							tenant: fixtureTenant,
							cache: destination,
							pushId: pin.pushId,
							cacheGeneration: arguments_[2].cacheGeneration,
							metadata: arguments_[2].metadata
						});
						const pushExpiry = pushIdExpiresAtSeconds(pin.pushId);
						if (pushExpiry === undefined) {
							throw new Error('Missing actual manifest push expiry');
						}
						const pruneAfterMs =
							Math.max(pushExpiry * 1000, Date.parse(pin.expiresAt)) +
							publicationCleanupMarginMs;
						const acceptedAt = new Date().toISOString();
						const graceDecisionJson = JSON.stringify({
							reportsGrace: true,
							graceSeconds: 0,
							retentionEpoch: 0,
							publicationId: arguments_[2].operationId,
							recoveryDeadline: pin.expiresAt
						});
						const accepted = await original.apply(this, arguments_);
						const before = await snapshot();
						initialUsage = before.usage;
						expect(before.ordinary).toStrictEqual([
							{
								id: identity.id,
								cacheId: accepted.cache.id,
								cacheGeneration: arguments_[2].cacheGeneration,
								pushId: pin.pushId,
								canonicalJson: identity.canonical,
								acceptedAt,
								pushExpiresAt: new Date(pushExpiry * 1000).toISOString(),
								recoveryDeadline: pin.expiresAt,
								pruneAfter: new Date(pruneAfterMs).toISOString(),
								blobJson: sqlNull,
								graceDecisionJson,
								graceDeadline: sqlNull,
								rootExpiresAt: sqlNull,
								state: 'accepted',
								resultJson: sqlNull,
								manifestOperationId: pin.operationId
							}
						]);
						expect(before.pending).toStrictEqual([
							{
								id: identity.id,
								acceptedSequence: sequence + 1,
								acceptedExpiresAt: pin.expiresAt,
								commitStartedSequence: sqlNull,
								cacheId: accepted.cache.id,
								retentionEpoch: 0,
								narHash: arguments_[2].metadata.narHash,
								r2Key: narObjectKey(arguments_[2].metadata.narHash),
								metadataJson: JSON.stringify({
									...arguments_[2].metadata,
									narSize: blob.narSize,
									fileHash: blob.fileHash,
									fileSize: blob.fileSize,
									compression: blob.compression
								}),
								recoveryDeadline: pin.expiresAt,
								createdAt: acceptedAt,
								expiresAt: pin.expiresAt,
								verdict: sqlNull,
								settleFailures: 0,
								settleRetryAfter: sqlNull,
								lastSettleError: sqlNull,
								retryStartedActiveMs: sqlNull,
								settleExhaustion: sqlNull,
								narRefreshPending: false,
								sessionId: sqlNull,
								claimedAt: sqlNull,
								claimOwner: sqlNull,
								commitReleased: false,
								graceDecisionJson,
								attachRootName: sqlNull,
								recordedVerdictJson: sqlNull,
								declaredFileHash: sqlNull,
								declaredFileSize: sqlNull,
								committedAt: sqlNull,
								promotionJson: sqlNull
							}
						]);
						expect({
							holds: before.holds,
							rows: before.rows,
							receipts: before.receipts,
							associations: before.associations,
							roots: before.roots,
							grace: before.grace,
							references: before.references
						}).toEqual({
							holds: [],
							rows: [],
							receipts: [],
							associations: [],
							roots: [],
							grace: [],
							references: []
						});
						expect(await original.apply(this, arguments_)).toEqual(accepted);
						expect(await snapshot()).toEqual(before);
						// Verification requires the durable commit-start marker. Interrupt
						// reservation only after commit has written that marker.
						const interruption = new Error(
							'interrupt concurrent commit before reservation'
						);
						const reserve = vi
							.spyOn(CommitPipelineService.prototype, 'reserveNarInfoRow')
							.mockRejectedValueOnce(interruption);
						await runInDurableObject(
							fixtureWorkerServer(),
							async (instance) => {
								const pipeline: unknown = Reflect.get(
									instance,
									'commitPipeline'
								);
								if (!(pipeline instanceof CommitPipelineService)) {
									throw new TypeError('Expected an ordinary commit pipeline');
								}
								await expect(
									pipeline.commit(
										rootLogger(),
										accepted.cache,
										arguments_[2].operationId,
										new ReuseAuthority({
											destination,
											grants: arguments_[3],
											views: []
										})
									)
								).rejects.toBe(interruption);
							}
						);
						reserve.mockRestore();
						await verifyTenant(
							rootLogger(),
							env,
							new NarReadBufferPool(),
							fixtureTenant
						);
						const verified = await snapshot();
						const row = verified.rows[0];
						if (row === undefined) {
							throw new Error(
								'Verification did not commit the accepted result'
							);
						}
						expect(verified.rows).toStrictEqual([
							{
								...sourceRow,
								cacheId: accepted.cache.id,
								storePath: f.result.storePath,
								narHash: f.result.narHash
							}
						]);
						expect(verified.pending).toEqual([]);
						await gc();
						const protectedState = await snapshot();
						expect(protectedState).toEqual(verified);
						expect(verified.admissions).toEqual([
							{ ...pin, cacheId: accepted.cache.id }
						]);
						expect(verified.mappings).toEqual([
							{
								operationId: pin.operationId,
								page: 0,
								payloadDigest: arguments_[2].operationId,
								payloadJson: JSON.stringify({
									kind: 'ensure-member-admission',
									storePath: f.result.storePath,
									publicationId: arguments_[2].operationId
								})
							}
						]);
						expect(verified.holds).toEqual([
							{
								operationId: pin.operationId,
								publicationId: arguments_[2].operationId,
								cacheId: accepted.cache.id,
								cacheGeneration: pin.cacheGeneration,
								storePathHash: row.storePathHash,
								storePath: row.storePath,
								narHash: row.narHash,
								generation: row.generation
							}
						]);
						expect(verified.ordinary).toEqual(
							before.ordinary.map((operation) => ({
								...operation,
								state: 'servable',
								resultJson: JSON.stringify({
									storePathHash: row.storePathHash,
									narHash: row.narHash,
									generation: row.generation
								})
							}))
						);
						expect(verified.references).toEqual([
							{
								tenant: fixtureTenant,
								cacheKind: 'named',
								cacheName: destination.name,
								storePathHash: row.storePathHash,
								generation: row.generation,
								narHash: row.narHash,
								readable: true,
								cacheGeneration: pin.cacheGeneration
							}
						]);
						expect(verified.usage).toEqual({
							...before.usage,
							narinfos: (before.usage?.narinfos ?? 0) + 1
						});
						if (release === 'expiry') {
							vi.setSystemTime(Date.parse(pin.expiresAt) - 1);
							await gc();
							expect(await snapshot()).toEqual(verified);
							vi.setSystemTime(Date.parse(pin.expiresAt));
							await gc();
							const expired = await snapshot();
							expect(expired).toEqual({
								...verified,
								rows: [],
								holds: [],
								references: [],
								usage: { ...before.usage, updatedAt: new Date().toISOString() }
							});
						}
						return accepted;
					});
				const response = await call(destination, '/ensure', f.token, f.request);
				expect(response.status, await response.clone().text()).toBe(
					release === 'expiry' ? 410 : 200
				);
				expect(spy).toHaveBeenCalled();
				spy.mockRestore();
				if (release === 'expiry') {
					return;
				}
				await complete(destination, f);
				const completed = await snapshot();
				await complete(destination, f);
				expect(await snapshot()).toEqual(completed);
				await gc();
				const collected = await snapshot();
				expect({
					rows: collected.rows,
					holds: collected.holds,
					references: collected.references,
					roots: collected.roots,
					grace: collected.grace
				}).toEqual({
					rows: [],
					holds: [],
					references: [],
					roots: [],
					grace: []
				});
				expect(collected).toEqual({
					...completed,
					rows: [],
					holds: [],
					references: [],
					associations: [],
					usage: initialUsage
				});
			}, fixtureWorkerServer());
		}
	);

	for (const schedule of [
		'healthy',
		'healthy-accepted',
		'healthy-path',
		'unbacked',
		'orphan-unbacked',
		'expired-unbacked',
		'expired-path'
	] as const) {
		it(`preserves the whole concurrent divergent destination through ${schedule} ordinary work`, async () => {
			const isPathWinner = (
				['healthy-path', 'expired-path'] as readonly string[]
			).includes(schedule);
			const isExpired = (
				['expired-path', 'expired-unbacked'] as readonly string[]
			).includes(schedule);
			const saved = await withoutAlarmArming(async () => {
				const f = await fixture();
				const destination = namedCache(`concurrent-${schedule}`);
				await committedPath(
					isPathWinner
						? `production-${String(sequence.next)}`
						: `divergent-${schedule}`,
					namedCache(`backing-${schedule}`),
					{
						storePathHash: StorePath.hash(f.result.storePath),
						name: isPathWinner ? 'other-result' : 'result'
					}
				);
				await putWorkerTestCache(f.token, destination);
				const configured = await authorisedWorkerFetch(
					`/caches/${destination.name}`,
					f.token,
					{
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ kind: 'set-grace', graceSeconds: 3600 })
					}
				);
				expect(configured.status).toBe(200);
				const snapshot = () =>
					runInDurableObject(fixtureWorkerServer(), async (instance) => {
						const cache = instance.context.cacheRepository.require(destination);
						return {
							references: await instance.context.d1
								.select()
								.from(d1Schema.blobReference)
								.where(
									and(
										eq(d1Schema.blobReference.tenant, fixtureTenant),
										eq(d1Schema.blobReference.cacheName, destination.name)
									)
								)
								.all(),
							usage: await instance.context.d1
								.select()
								.from(d1Schema.tenantUsage)
								.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
								.all(),
							rows: instance.context.db
								.select()
								.from(schema.narInfos)
								.where(eq(schema.narInfos.cacheId, cache.id))
								.all(),
							grace: instance.context.db
								.select()
								.from(schema.retentionGrace)
								.where(eq(schema.retentionGrace.cacheId, cache.id))
								.all(),
							roots: instance.context.db
								.select()
								.from(schema.retentionRootTargets)
								.where(eq(schema.retentionRootTargets.cacheId, cache.id))
								.all()
						};
					});
				const winner = async () =>
					committedPath(
						isPathWinner
							? `production-${String(sequence.next)}`
							: `divergent-${schedule}`,
						destination,
						{
							storePathHash: StorePath.hash(f.result.storePath),
							name: isPathWinner ? 'other-result' : 'result'
						}
					);
				let before: Awaited<ReturnType<typeof snapshot>> | undefined;
				if (
					(
						['healthy', 'healthy-accepted', 'healthy-path'] as readonly string[]
					).includes(schedule)
				) {
					const descriptor:
						| TypedPropertyDescriptor<UploadsService['admitPublication']>
						| undefined = Object.getOwnPropertyDescriptor(
						UploadsService.prototype,
						'admitPublication'
					);
					const original = descriptor?.value;
					if (original === undefined) {
						throw new Error('Missing admission');
					}
					vi.spyOn(
						UploadsService.prototype,
						'admitPublication'
					).mockImplementationOnce(async function (
						this: UploadsService,
						...arguments_
					) {
						const accepted =
							schedule === 'healthy-accepted'
								? await original.apply(this, arguments_)
								: undefined;
						const b = await winner();
						if (isPathWinner) {
							expect(b.narHash).toBe(f.result.narHash);
							expect(b.storePath).not.toBe(f.result.storePath);
						} else {
							expect(b.narHash).not.toBe(f.result.narHash);
						}
						before = await snapshot();
						vi.setSystemTime(Date.now() + 30_000);
						return accepted ?? original.apply(this, arguments_);
					});
					const response = await call(
						destination,
						'/ensure',
						f.token,
						f.request
					);
					expect(response.status).toBe(409);
				} else {
					// Crash after the actual ordinary saga marker, before reservation.
					const reserve = vi
						.spyOn(CommitPipelineService.prototype, 'reserveNarInfoRow')
						.mockRejectedValueOnce(new Error('crash before reservation'));
					const response = await call(
						destination,
						'/ensure',
						f.token,
						f.request
					);
					expect(response.status).toBe(500);
					reserve.mockRestore();
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						const destinationCacheId =
							instance.context.cacheRepository.require(destination).id;
						const pending = instance.context.db
							.select()
							.from(schema.pendingUploads)
							.where(eq(schema.pendingUploads.cacheId, destinationCacheId))
							.all();
						expect(pending.map((row) => row.verdict)).toEqual(['committing']);
					});
					const b = await winner();
					if (isPathWinner) {
						expect(b.narHash).toBe(f.result.narHash);
						expect(b.storePath).not.toBe(f.result.storePath);
					} else {
						expect(b.narHash).not.toBe(f.result.narHash);
					}
					const backing = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
						.select()
						.from(d1Schema.blobState)
						.where(
							eq(d1Schema.blobState.narHash, f.request.source.result.narHash)
						)
						.get();
					const lost = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
						.select()
						.from(d1Schema.blobState)
						.where(
							eq(
								d1Schema.blobState.narHash,
								nixSha256HashSchema.parse(b.narHash)
							)
						)
						.get();
					if (lost === undefined || backing === undefined) {
						throw new Error('Missing backing state');
					}
					if (!isPathWinner) {
						await env.BLOBS.delete(
							narObjectKey(lost.narHash, lost.incarnation)
						);
					}
					expect(
						await env.BLOBS.head(
							narObjectKey(backing.narHash, backing.incarnation)
						)
					).not.toBeNull();
					if (!isPathWinner) {
						expect(
							await env.BLOBS.head(narObjectKey(lost.narHash, lost.incarnation))
						).toBeNull();
					}
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						const destinationCacheId =
							instance.context.cacheRepository.require(destination).id;
						expect(
							instance.context.db
								.select()
								.from(schema.pendingUploads)
								.where(eq(schema.pendingUploads.cacheId, destinationCacheId))
								.all()
								.map((row) => row.verdict)
						).toEqual(['committing']);
					});
					before = await snapshot();
					if (isExpired) {
						const deadline = await runInDurableObject(
							fixtureWorkerServer(),
							(instance) => {
								const admission = instance.context.db
									.select()
									.from(schema.publicationManifestAdmissions)
									.where(
										eq(
											schema.publicationManifestAdmissions.destinationName,
											destination.name
										)
									)
									.get();
								if (admission === undefined) {
									throw new Error('Missing admission');
								}
								return admission.pruneAfter;
							}
						);
						vi.setSystemTime(Date.parse(deadline) + 1);
						await runInDurableObject(fixtureWorkerServer(), (instance) => {
							const destinationCacheId =
								instance.context.cacheRepository.require(destination).id;
							const cleanup = new PublicationManifestCleanup(
								instance.context.db
							);
							for (
								let step = 0;
								step < 100 && cleanup.hasWork(isoTimestamp(new Date()));
								step += 1
							) {
								withRowBudget(() =>
									cleanup.collect(isoTimestamp(new Date()), 64)
								);
							}
							new PublicationStore(instance.context).prune(
								new Date().toISOString()
							);
							expect(
								instance.context.db
									.select()
									.from(schema.publicationManifestAdmissions)
									.where(
										eq(
											schema.publicationManifestAdmissions.destinationName,
											destination.name
										)
									)
									.all()
							).toEqual([]);
							expect(
								instance.context.db
									.select()
									.from(schema.publicationOperations)
									.where(
										eq(schema.publicationOperations.cacheId, destinationCacheId)
									)
									.all()
									.map((row) => row.state)
							).toEqual(['accepted']);
						});
					}
				}
				expect(before).toBeDefined();
				expect(await snapshot()).toEqual(before);
				const work = await runInDurableObject(
					fixtureWorkerServer(),
					(instance) => {
						const cache = instance.context.cacheRepository.require(destination);
						const operations = instance.context.db
							.select()
							.from(schema.publicationOperations)
							.where(eq(schema.publicationOperations.cacheId, cache.id))
							.all();
						const pending = instance.context.db
							.select()
							.from(schema.pendingUploads)
							.where(eq(schema.pendingUploads.cacheId, cache.id))
							.all();
						if (operations.length > 0) {
							const operation = operations[0];
							if (operation === undefined) {
								throw new Error('Missing operation');
							}
							const declaration = z
								.array(z.unknown())
								.parse(JSON.parse(operation.canonicalJson));
							expect(declaration.at(-1)).toBeNull();
							expect(declaration.slice(0, -1)).toEqual([
								'cupboard/publication/v1',
								fixtureTenant,
								'named',
								destination.name,
								1,
								operation.pushId,
								expect.arrayContaining([f.result.storePath, f.result.narHash])
							]);
							if (isExpired && operation.manifestOperationId !== null) {
								expect(
									instance.context.db
										.select()
										.from(schema.publicationManifestOperationPages)
										.where(
											eq(
												schema.publicationManifestOperationPages.operationId,
												operation.manifestOperationId
											)
										)
										.all()
								).toEqual([]);
								expect(
									instance.context.db
										.select()
										.from(schema.publicationManifestOperations)
										.where(
											eq(
												schema.publicationManifestOperations.id,
												operation.manifestOperationId
											)
										)
										.all()
								).toEqual([]);
							}
							if (!isExpired && operation.manifestOperationId !== null) {
								const admission = instance.context.db
									.select()
									.from(schema.publicationManifestAdmissions)
									.where(
										eq(
											schema.publicationManifestAdmissions.operationId,
											operation.manifestOperationId
										)
									)
									.get();
								expect(admission?.pushId).toBe(operation.pushId);
							}
						}
						if (schedule === 'orphan-unbacked') {
							for (const operation of operations) {
								instance.context.db
									.delete(schema.publicationOperations)
									.where(eq(schema.publicationOperations.id, operation.id))
									.run();
							}
						}
						return { operations, pending };
					}
				);
				return { before, snapshot, destination, work };
			}, fixtureWorkerServer());
			await restartTestServers();
			await withoutAlarmArming(async () => {
				for (let pass = 0; pass < 3; pass += 1) {
					if (isExpired) {
						await runInDurableObject(fixtureWorkerServer(), (instance) =>
							verificationOf(instance).expirePublications(rootLogger())
						);
					} else {
						// Drive the real pending-work maintenance seam, separately from the
						// independent committed-row scan which may legitimately reap lost B.
						await runInDurableObject(fixtureWorkerServer(), (instance) =>
							verificationOf(instance).processPendingWithoutDecode(
								rootLogger(),
								100
							)
						);
					}
					await verifyTenant(
						rootLogger(),
						env,
						new NarReadBufferPool(),
						fixtureTenant
					);
					expect(await saved.snapshot()).toEqual(saved.before);
					for (const operation of saved.work.operations) {
						expect(operation.manifestOperationId).toBeTypeOf('string');
					}
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						const destinationCacheId = instance.context.cacheRepository.require(
							saved.destination
						).id;
						expect(
							instance.context.db
								.select()
								.from(schema.pendingUploads)
								.where(eq(schema.pendingUploads.cacheId, destinationCacheId))
								.all()
						).toEqual(
							schedule === 'healthy-accepted' ? saved.work.pending : []
						);
						expect(
							instance.context.db
								.select()
								.from(schema.publicationOperations)
								.where(
									eq(schema.publicationOperations.cacheId, destinationCacheId)
								)
								.all()
						).toEqual(
							schedule === 'orphan-unbacked' || isExpired
								? []
								: saved.work.operations.map((operation) =>
										schedule === 'healthy-accepted'
											? operation
											: {
													...operation,
													state: 'failed',
													resultJson: JSON.stringify({ verdict: 'mismatch' })
												}
									)
						);
					});
				}
			}, fixtureWorkerServer());
		});
	}

	it.each([
		'origin',
		'mapping',
		'scope',
		'cache-id',
		'generation',
		'request-generation',
		'push',
		'declaration',
		'expiry',
		'rollback'
	] as const)(
		'refuses inconsistent private manifest %s before ordinary acceptance',
		async (mismatch) => {
			await withoutAlarmArming(async () => {
				const f = await fixture();
				const destination = namedCache(`inconsistent-${mismatch}`);
				const descriptor:
					| TypedPropertyDescriptor<UploadsService['admitPublication']>
					| undefined = Object.getOwnPropertyDescriptor(
					UploadsService.prototype,
					'admitPublication'
				);

				const original = descriptor?.value;
				if (original === undefined) {
					throw new Error('Missing admission');
				}
				let isRollbackReached = false;
				let pinned:
					typeof schema.publicationManifestAdmissions.$inferSelect | undefined;
				vi.spyOn(
					UploadsService.prototype,
					'admitPublication'
				).mockImplementationOnce(async function (
					this: UploadsService,
					...arguments_
				) {
					switch (mismatch) {
						case 'origin': {
							arguments_[5] = undefined;

							break;
						}
						case 'mapping': {
							await runInDurableObject(fixtureWorkerServer(), (instance) => {
								const operationId = arguments_[5];
								if (operationId === undefined) {
									throw new Error('Missing actual origin');
								}
								const page = instance.context.db
									.select()
									.from(schema.publicationManifestOperationPages)
									.where(
										eq(
											schema.publicationManifestOperationPages.operationId,
											operationId
										)
									)
									.get();
								if (page === undefined) {
									throw new Error('Missing actual mapping');
								}
								instance.context.db
									.delete(schema.publicationManifestOperationPages)
									.where(
										and(
											eq(
												schema.publicationManifestOperationPages.operationId,
												operationId
											),
											eq(
												schema.publicationManifestOperationPages.page,
												page.page
											)
										)
									)
									.run();
							});

							break;
						}
						case 'declaration':
						case 'push': {
							if (mismatch === 'push') {
								arguments_[1] = await testPushIdFor(fixtureTenant);
							} else {
								arguments_[2].metadata = {
									...arguments_[2].metadata,
									narSize: arguments_[2].metadata.narSize + 1
								};
							}
							const identity = await publicationIdentity({
								tenant: fixtureTenant,
								cache: arguments_[0],
								pushId: arguments_[1],
								cacheGeneration: arguments_[2].cacheGeneration,
								metadata: arguments_[2].metadata
							});
							arguments_[2] = { ...arguments_[2], operationId: identity.id };

							break;
						}
						default: {
							break;
						}
					}
					pinned = await runInDurableObject(
						fixtureWorkerServer(),
						(instance) => {
							const table = schema.publicationManifestAdmissions;
							const row = instance.context.db
								.select()
								.from(table)
								.where(eq(table.destinationName, destination.name))
								.get();
							if (row === undefined) {
								throw new Error('Missing durable pin');
							}
							switch (mismatch) {
								case 'scope': {
									instance.context.db
										.update(table)
										.set({
											destinationName:
												f.source.kind === 'named'
													? f.source.name
													: destination.name
										})
										.where(eq(table.operationId, row.operationId))
										.run();

									break;
								}
								case 'cache-id': {
									instance.context.db
										.update(table)
										.set({
											cacheId: instance.context.cacheRepository.require(
												f.source
											).id
										})
										.where(eq(table.operationId, row.operationId))
										.run();

									break;
								}
								case 'generation': {
									instance.context.db
										.update(table)
										.set({ cacheGeneration: cacheGenerationSchema.parse(2) })
										.where(eq(table.operationId, row.operationId))
										.run();

									break;
								}
								case 'request-generation': {
									instance.context.db
										.update(table)
										.set({
											canonicalJson: JSON.stringify({
												...f.request,
												expectedDestinationGeneration: 2
											})
										})
										.where(eq(table.operationId, row.operationId))
										.run();

									break;
								}
								case 'expiry': {
									const expiredAt = isoTimestamp(new Date(Date.now() - 1));
									instance.context.db
										.update(table)
										.set({ expiresAt: expiredAt })
										.where(eq(table.operationId, row.operationId))
										.run();

									break;
								}
								default: {
									break;
								}
							}
							return instance.context.db
								.select()
								.from(table)
								.where(eq(table.operationId, row.operationId))
								.get();
						}
					);
					if (mismatch === 'rollback') {
						await runInDurableObject(fixtureWorkerServer(), (instance) => {
							vi.spyOn(
								WorkSequenceService.prototype,
								'allocate'
							).mockImplementationOnce(() => {
								const table = schema.publicationManifestAdmissions;
								// This is reached after the real binding and operation insert,
								// while pending acceptance is still in the same transaction.
								expect(
									instance.context.db
										.select()
										.from(table)
										.where(eq(table.operationId, pinned?.operationId ?? ''))
										.get()
								).toEqual({
									...pinned,
									cacheId:
										instance.context.cacheRepository.require(destination).id
								});
								expect(
									instance.context.db
										.select()
										.from(schema.publicationOperations)
										.where(
											eq(
												schema.publicationOperations.id,
												arguments_[2].operationId
											)
										)
										.get()?.state
								).toBe('accepted');
								isRollbackReached = true;
								throw new Error(
									'interrupt pending insertion after transactional admission binding'
								);
							});
						});
					}
					return original.apply(this, arguments_);
				});
				const response = await call(destination, '/ensure', f.token, f.request);
				expect(response.status).toBe(mismatch === 'rollback' ? 500 : 409);
				expect(isRollbackReached).toBe(mismatch === 'rollback');
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					const cache = instance.context.cacheRepository.require(destination);
					expect(
						instance.context.db
							.select()
							.from(schema.publicationManifestAdmissions)
							.where(
								eq(
									schema.publicationManifestAdmissions.operationId,
									pinned?.operationId ?? ''
								)
							)
							.get()
					).toEqual(pinned);
					expect({
						operations: instance.context.db
							.select()
							.from(schema.publicationOperations)
							.where(eq(schema.publicationOperations.cacheId, cache.id))
							.all(),
						pending: instance.context.db
							.select()
							.from(schema.pendingUploads)
							.where(eq(schema.pendingUploads.cacheId, cache.id))
							.all(),
						rows: instance.context.db
							.select()
							.from(schema.narInfos)
							.where(eq(schema.narInfos.cacheId, cache.id))
							.all(),
						grace: instance.context.db
							.select()
							.from(schema.retentionGrace)
							.where(eq(schema.retentionGrace.cacheId, cache.id))
							.all(),
						roots: instance.context.db
							.select()
							.from(schema.retentionRootTargets)
							.where(eq(schema.retentionRootTargets.cacheId, cache.id))
							.all()
					}).toEqual({
						operations: [],
						pending: [],
						rows: [],
						grace: [],
						roots: []
					});
				});
			}, fixtureWorkerServer());
		}
	);

	for (const mutation of ['revoke', 'demote'] as const) {
		it(`carries the foreign-source destination result proof across admission ${mutation}/drain`, async () => {
			await withoutAlarmArming(async () => {
				const f = await fixture();
				const destination = namedCache(`fenced-admission-${mutation}`);
				const copied = await committedPath(
					`production-${String(sequence.next)}`,
					destination,
					{ storePathHash: StorePath.hash(f.result.storePath), name: 'result' }
				);
				expect(copied.narHash).toBe(f.result.narHash);
				const descriptor:
					| TypedPropertyDescriptor<
							ProductionPublicationManifestPublisher['admit']
					  >
					| undefined = Object.getOwnPropertyDescriptor(
					ProductionPublicationManifestPublisher.prototype,
					'admit'
				);
				const admit = descriptor?.value;
				if (admit === undefined) {
					throw new Error('Missing production adapter');
				}
				const observation = vi
					.spyOn(ProductionPublicationManifestPublisher.prototype, 'admit')
					.mockImplementationOnce(async function (
						this: ProductionPublicationManifestPublisher,
						input
					) {
						const admitted = await admit.call(this, input);
						const confirmation = admitted.confirmation;
						if (confirmation === undefined) {
							throw new Error('Missing observed destination confirmation');
						}
						expect(confirmation.cache.scope).toStrictEqual(destination);
						await runInDurableObject(
							fixtureWorkerServer(),
							async (instance) => {
								const cache =
									instance.context.cacheRepository.require(destination);
								const row = instance.context.db
									.select()
									.from(schema.narInfos)
									.where(eq(schema.narInfos.cacheId, cache.id))
									.get();
								if (row === undefined) {
									throw new Error('Missing destination result');
								}
								if (mutation === 'revoke') {
									await new PathReadAuthorityService(instance.context).revoke(
										cache,
										[row]
									);
								} else {
									const state = await instance.context.d1
										.select()
										.from(d1Schema.blobState)
										.where(eq(d1Schema.blobState.narHash, row.narHash))
										.get();
									if (state === undefined) {
										throw new Error('Missing canonical NAR');
									}
									await instance.context.env.BLOBS.delete(
										narObjectKey(row.narHash, state.incarnation)
									);
									await new NarInfoObjectsService(
										instance.context
									).demoteUnbacked(cache, row.storePathHash, row.narHash);
								}
								expect(
									new PublicationManifestAvailabilityStore(
										instance.context.db
									).hasPending({
										cacheId: cache.id,
										cacheGeneration: cache.generation
									})
								).toBe(false);
								expect(
									instance.context.db
										.select()
										.from(schema.narInfos)
										.where(eq(schema.narInfos.cacheId, cache.id))
										.get()
								).toStrictEqual(row);
								expect(() =>
									new PublicationManifestAuthority(instance.context).revalidate(
										confirmation,
										input.grants
									)
								).toThrow(
									expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' })
								);
							}
						);
						return admitted;
					});
				try {
					const response = await call(
						destination,
						'/ensure',
						f.token,
						f.request
					);
					expect(response.status).toBe(503);
					expect(observation).toHaveBeenCalledOnce();
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						const cache = instance.context.cacheRepository.require(destination);
						expect(
							instance.context.db
								.select()
								.from(schema.publicationManifestOperations)
								.where(
									eq(schema.publicationManifestOperations.cacheId, cache.id)
								)
								.all()
						).toHaveLength(0);
						expect(
							instance.context.db
								.select()
								.from(schema.publicationManifestWorkHolds)
								.where(
									eq(schema.publicationManifestWorkHolds.cacheId, cache.id)
								)
								.all()
						).toHaveLength(0);
					});
				} finally {
					observation.mockRestore();
				}
			}, fixtureWorkerServer());
		});
	}

	it.each([defaultCache(), namedCache('destination')])(
		'serves all routes and promotes first destination through ordinary publication: %j',
		async (destination) => {
			const f = await fixture();
			const ensured = await complete(destination, f);
			expect(ensured.kind).toBe('complete');
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const admissions = instance.context.db
					.select()
					.from(schema.publicationManifestAdmissions)
					.all()
					.filter(
						(row) =>
							publicationEnsureRequestSchema.parse(
								JSON.parse(row.canonicalJson)
							).requestId === f.request.requestId
					);
				expect(admissions).toHaveLength(1);
				const pages = instance.context.db
					.select()
					.from(schema.publicationManifestOperationPages)
					.where(
						eq(
							schema.publicationManifestOperationPages.operationId,
							admissions[0]?.operationId ?? ''
						)
					)
					.all();
				expect(pages).toHaveLength(2);
				const operations = instance.context.db
					.select()
					.from(schema.publicationOperations)
					.all()
					.filter((row) => row.pushId === admissions[0]?.pushId);
				expect(operations).toHaveLength(2);
				expect(
					operations.every(
						(row) =>
							row.state === 'servable' &&
							row.pushId === admissions[0]?.pushId &&
							row.recoveryDeadline === admissions[0].expiresAt
					)
				).toBe(true);
				expect(
					new Set(
						pages.map(
							(page) =>
								ensureMemberAdmissionSchema.parse(JSON.parse(page.payloadJson))
									.publicationId
						)
					)
				).toEqual(new Set(operations.map((row) => row.id)));
			});
			const lookup = await call(destination, '/lookup', f.token, {
				results: [{ storePath: f.result.storePath }],
				source: { cache: destination }
			});
			expect(lookup.status).toBe(200);
		}
	);

	it.each([false, true])(
		'reuses a cold overlapping set without ordinary admissions (source member absent: %s)',
		async (absent) => {
			const f = await fixture(undefined, 'public', 3);
			const destination = namedCache('cold-overlap');
			await complete(destination, f);
			const configured = await authorisedWorkerFetch(
				`/caches/${destination.name}`,
				f.token,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: 'set-grace', graceSeconds: 0 })
				}
			);
			expect(configured.status).toBe(200);
			const members = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) => {
					const cache = instance.context.cacheRepository.require(f.source);
					return instance.context.db
						.select()
						.from(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, cache.id))
						.all()
						.filter(
							(row) =>
								row.storePath === f.result.storePath ||
								row.storePath === f.child.storePath
						)
						.map((row) => ({
							storePath: row.storePath,
							narHash: row.narHash,
							generation: row.generation
						}));
				}
			);
			expect(members).toHaveLength(2);
			const result = members.find(
				(member) => member.storePath === f.child.storePath
			);
			if (result === undefined) {
				throw new Error('Missing child');
			}
			const beginResponse = await call(f.source, '/captures', f.token, {
				result,
				requestId: createPublicationRequestId(),
				expectedCacheGeneration: 1,
				origin: 'build-selection',
				memberCount: 2
			});
			const begin = publicationCaptureBeginResponseSchema.parse(
				await beginResponse.json()
			);
			if (begin.kind !== 'staging') {
				throw new Error('Expected staging');
			}
			const pageResponse = await call(
				f.source,
				`/captures/${begin.operationId}/pages/0`,
				f.token,
				{ members },
				'PUT'
			);
			expect(pageResponse.status).toBe(200);
			for (let step = 0; step < 12; step += 1) {
				const sealedResponse = await call(
					f.source,
					`/captures/${begin.operationId}/seal`,
					f.token,
					{}
				);
				const sealed = publicationCaptureSealResponseSchema.parse(
					await sealedResponse.json()
				);
				if (sealed.kind !== 'captured') {
					continue;
				}
				if (absent) {
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						const cache = instance.context.cacheRepository.require(f.source);
						instance.context.db
							.delete(schema.narInfos)
							.where(
								and(
									eq(schema.narInfos.cacheId, cache.id),
									eq(
										schema.narInfos.storePath,
										f.request.source.result.storePath
									)
								)
							)
							.run();
					});
				}
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					withRowBudget(() =>
						new PublicationManifestCleanup(instance.context.db).collect(
							isoTimestamp(new Date()),
							64
						)
					);
				});
				const descriptor:
					| TypedPropertyDescriptor<
							PublicationManifestEnsureService['continue']
					  >
					| undefined = Object.getOwnPropertyDescriptor(
					PublicationManifestEnsureService.prototype,
					'continue'
				);
				const original = descriptor?.value;
				if (original === undefined) {
					throw new Error('Missing continuation');
				}
				let hasCheckedHolds = false;
				vi.spyOn(
					PublicationManifestEnsureService.prototype,
					'continue'
				).mockImplementation(async function (
					this: PublicationManifestEnsureService,
					...arguments_
				) {
					const response = await original.apply(this, arguments_);
					if (hasCheckedHolds || response.kind !== 'pending') {
						return response;
					}
					const staged = await runInDurableObject(
						fixtureWorkerServer(),
						(instance) =>
							instance.context.db
								.select()
								.from(schema.publicationManifestOperations)
								.where(
									eq(
										schema.publicationManifestOperations.id,
										response.operationId
									)
								)
								.get()
					);
					if (
						staged?.cursor !== staged?.expectedCount ||
						staged?.progressJson !== JSON.stringify({ phase: 'members' })
					) {
						return response;
					}
					hasCheckedHolds = true;
					const gc = await authorisedWorkerFetch(
						`${prefix(destination)}/gc`,
						f.token,
						{ method: 'POST' }
					);
					expect(gc.status).toBe(200);
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						withRowBudget(() =>
							new PublicationManifestCleanup(instance.context.db).collect(
								isoTimestamp(new Date()),
								64
							)
						);
						const cache = instance.context.cacheRepository.require(destination);
						const paths = instance.context.db
							.select()
							.from(schema.narInfos)
							.where(eq(schema.narInfos.cacheId, cache.id))
							.all()
							.map((row) => row.storePath);
						for (const member of members) {
							expect(paths).toContain(member.storePath);
						}
						expect(
							instance.context.db
								.select()
								.from(schema.retentionGrace)
								.where(eq(schema.retentionGrace.cacheId, cache.id))
								.all()
						).toHaveLength(0);
						expect(
							instance.context.db
								.select()
								.from(schema.retentionRootTargets)
								.where(eq(schema.retentionRootTargets.cacheId, cache.id))
								.all()
						).toHaveLength(0);
					});
					return response;
				});
				const admissions = vi.spyOn(
					UploadsService.prototype,
					'admitPublication'
				);
				const completed = await complete(destination, {
					...f,
					request: publicationEnsureRequestSchema.parse({
						...f.request,
						requestId: createPublicationRequestId(),
						source: sealed.publication
					})
				});
				expect(completed.publication.result.storePath).toBe(f.child.storePath);
				expect(admissions).not.toHaveBeenCalled();
				expect(hasCheckedHolds).toBe(true);
				const gc = await authorisedWorkerFetch(
					`${prefix(destination)}/gc`,
					f.token,
					{ method: 'POST' }
				);
				expect(gc.status).toBe(200);
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					const cache = instance.context.cacheRepository.require(destination);
					expect(
						instance.context.db
							.select()
							.from(schema.narInfos)
							.where(eq(schema.narInfos.cacheId, cache.id))
							.all()
					).toHaveLength(0);
				});
				return;
			}
			throw new Error('Capture did not converge');
		}
	);

	it.each([false, true])(
		'refuses identical expired replay before and after receipt cleanup without refreshing finite grace (warm: %s)',
		async (warm) => {
			const f = await fixture();
			const destination = namedCache('expired-warm-replay');
			await complete(destination, f);
			const graceResponse = await authorisedWorkerFetch(
				`/caches/${destination.name}`,
				f.token,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: 'set-grace', graceSeconds: 3600 })
				}
			);
			expect(graceResponse.status).toBe(200);
			const request = publicationEnsureRequestSchema.parse({
				...f.request,
				requestId: createPublicationRequestId()
			});
			if (!warm) {
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					const cache = instance.context.cacheRepository.require(destination);
					instance.context.db
						.delete(schema.resultPublications)
						.where(eq(schema.resultPublications.cacheId, cache.id))
						.run();
				});
			}
			await complete(destination, { ...f, request });
			const grace = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					instance.context.db.select().from(schema.retentionGrace).all()
			);
			vi.setSystemTime(Date.now() + 86_400_001 + publicationCleanupMarginMs);
			const token = await initialiseViaWorker();
			const expiredResponse = await call(
				destination,
				'/ensure',
				token,
				request
			);
			expect(expiredResponse.status).toBe(410);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cleanup = new PublicationManifestCleanup(instance.context.db);
				const canonicalJson = JSON.stringify(request);
				const now = isoTimestamp(new Date());
				for (let page = 0; page < 100 && cleanup.hasWork(now); page += 1) {
					withRowBudget(() => cleanup.collect(now, 64));
				}
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.where(
							eq(
								schema.publicationManifestOperations.requestId,
								request.requestId
							)
						)
						.all()
				).toHaveLength(0);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestAdmissions)
						.where(
							eq(
								schema.publicationManifestAdmissions.canonicalJson,
								canonicalJson
							)
						)
						.all()
				).toHaveLength(0);
			});
			const prunedResponse = await call(destination, '/ensure', token, request);
			expect(prunedResponse.status).toBe(410);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				expect(
					instance.context.db.select().from(schema.retentionGrace).all()
				).toEqual(grace);
			});
		}
	);

	it('keeps a T+4min warm UUID tombstone after server expiry without renewing recovery or grace', async () => {
		await withoutAlarmArming(async () => {
			const f = await fixture();
			const destination = namedCache('future-warm-replay');
			await complete(destination, f);
			const response = await authorisedWorkerFetch(
				`/caches/${destination.name}`,
				f.token,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: 'set-grace', graceSeconds: 3600 })
				}
			);
			expect(response.status).toBe(200);
			const start = Date.now();
			vi.setSystemTime(start + 4 * 60_000);
			const request = publicationEnsureRequestSchema.parse({
				...f.request,
				requestId: createPublicationRequestId()
			});
			vi.setSystemTime(start);
			await complete(destination, { ...f, request });
			const saved = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) => ({
					operation: instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.where(
							eq(
								schema.publicationManifestOperations.requestId,
								request.requestId
							)
						)
						.get(),
					grace: instance.context.db.select().from(schema.retentionGrace).all()
				})
			);
			expect(saved.operation?.expiresAt).toBe(
				new Date(start + 86_400_000).toISOString()
			);
			for (const offset of [86_400_000, 86_460_000]) {
				vi.setSystemTime(start + offset);
				const token = await initialiseViaWorker();
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					const cleanup = new PublicationManifestCleanup(instance.context.db);
					withRowBudget(() => cleanup.collect(isoTimestamp(new Date()), 64));
					expect(
						instance.context.db
							.select()
							.from(schema.publicationManifestOperations)
							.where(
								eq(
									schema.publicationManifestOperations.requestId,
									request.requestId
								)
							)
							.get()
					).toEqual(saved.operation);
				});
				const replay = await call(destination, '/ensure', token, request);
				expect(replay.status).toBe(410);
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					expect(
						instance.context.db.select().from(schema.retentionGrace).all()
					).toEqual(saved.grace);
				});
			}
			vi.setSystemTime(start + 86_400_001 + publicationCleanupMarginMs);
			const token = await initialiseViaWorker();
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cleanup = new PublicationManifestCleanup(instance.context.db);
				for (
					let page = 0;
					page < 100 && cleanup.hasWork(isoTimestamp(new Date()));
					page += 1
				) {
					withRowBudget(() => cleanup.collect(isoTimestamp(new Date()), 64));
				}
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.where(
							eq(
								schema.publicationManifestOperations.requestId,
								request.requestId
							)
						)
						.all()
				).toEqual([]);
				expect(
					instance.context.db.select().from(schema.retentionGrace).all()
				).toEqual(saved.grace);
			});
			const pruned = await call(destination, '/ensure', token, request);
			expect(pruned.status).toBe(410);
		}, fixtureWorkerServer());
	});

	it('refuses an unknown untimestamped request before destination registration or admission', async () => {
		const f = await fixture();
		const destination = namedCache('untimestamped-request');
		const admission = vi.spyOn(UploadsService.prototype, 'admitPublication');
		const response = await call(destination, '/ensure', f.token, {
			...f.request,
			requestId: crypto.randomUUID()
		});
		expect(response.status).toBe(410);
		expect(admission).not.toHaveBeenCalled();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			expect(
				instance.context.cacheRepository.resolve(destination)
			).toBeUndefined();
		});
	});

	it('recovers when a competing normal commit settles and removes the pending upload after admission', async () => {
		const f = await fixture();
		const destination = namedCache('concluded-after-admission');
		const descriptor:
			TypedPropertyDescriptor<CommitPipelineService['commit']> | undefined =
			Object.getOwnPropertyDescriptor(
				CommitPipelineService.prototype,
				'commit'
			);
		const original = descriptor?.value;
		if (original === undefined) {
			throw new Error('Missing commit');
		}
		const commit = vi
			.spyOn(CommitPipelineService.prototype, 'commit')
			.mockImplementationOnce(async function (
				this: CommitPipelineService,
				...arguments_
			) {
				const competing = await original.apply(this, arguments_);
				expect(competing.kind).toBe('settled');
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					expect(
						instance.context.db
							.select()
							.from(schema.pendingUploads)
							.where(eq(schema.pendingUploads.id, arguments_[2]))
							.all()
					).toHaveLength(0);
					expect(
						instance.context.db
							.select()
							.from(schema.publicationOperations)
							.where(eq(schema.publicationOperations.id, arguments_[2]))
							.get()?.state
					).toBe('servable');
				});
				return original.apply(this, arguments_);
			});
		await complete(destination, f);
		expect(commit).toHaveBeenCalled();
	});

	it.each([
		'pin-only',
		'ordinary-admitted',
		'ordinary-failed',
		'ordinary-expired'
	] as const)(
		'recovers %s before warm success with its once-only original retention decision',
		async (stage) => {
			const f = await fixture();
			const destination = namedCache(`warm-recovery-${stage}`);
			await putWorkerTestCache(f.token, destination);
			await withoutAlarmArming(async () => {
				const configureGrace = async (graceSeconds: number) => {
					const response = await authorisedWorkerFetch(
						`/caches/${destination.name}`,
						f.token,
						{
							method: 'PATCH',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ kind: 'set-grace', graceSeconds })
						}
					);
					expect(response.status).toBe(200);
				};
				const snapshot = () =>
					runInDurableObject(fixtureWorkerServer(), (instance) => {
						const database = instance.context.db;
						const cache = instance.context.cacheRepository.require(destination);
						const admissions = database
							.select()
							.from(schema.publicationManifestAdmissions)
							.all()
							.filter((row) => row.canonicalJson === JSON.stringify(f.request));
						const pin = admissions[0];
						return {
							cache,
							admissions,
							receipts: database
								.select()
								.from(schema.publicationManifestOperations)
								.all()
								.filter((row) => row.requestId === f.request.requestId),
							mappings: database
								.select()
								.from(schema.publicationManifestOperationPages)
								.all()
								.filter((row) => row.operationId === pin?.operationId),
							ordinary: database
								.select()
								.from(schema.publicationOperations)
								.all()
								.filter((row) => row.pushId === pin?.pushId),
							pending: database
								.select()
								.from(schema.pendingUploads)
								.all()
								.filter((row) => row.cacheId === cache.id),
							grace: database
								.select()
								.from(schema.retentionGrace)
								.where(eq(schema.retentionGrace.cacheId, cache.id))
								.orderBy(schema.retentionGrace.storePathHash)
								.all()
						};
					});
				await configureGrace(7200);
				const blob = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
					.select()
					.from(d1Schema.blobState)
					.where(
						eq(d1Schema.blobState.narHash, f.request.source.result.narHash)
					)
					.get();
				if (blob === undefined) {
					throw new Error('Missing committed fixture blob');
				}
				const acceptedSequence = await runInDurableObject(
					fixtureWorkerServer(),
					(instance) =>
						new WorkSequenceService(instance.context.db).current() + 1
				);
				const startedAt = Date.now();
				if (stage === 'pin-only') {
					const descriptor:
						| TypedPropertyDescriptor<
								PublicationManifestAuthority['requireServable']
						  >
						| undefined = Object.getOwnPropertyDescriptor(
						PublicationManifestAuthority.prototype,
						'requireServable'
					);
					const original = descriptor?.value;
					if (original === undefined) {
						throw new Error('Missing authority probe');
					}
					vi.spyOn(
						PublicationManifestAuthority.prototype,
						'requireServable'
					).mockImplementation(async function (
						this: PublicationManifestAuthority,
						source
					) {
						await original.call(this, source);
						const durable = await snapshot();
						if (durable.admissions.length > 0) {
							throw new Error(
								'interrupted authority reply after durable pin before ordinary mapping'
							);
						}
					});
				} else {
					const descriptor:
						| TypedPropertyDescriptor<UploadsService['admitPublication']>
						| undefined = Object.getOwnPropertyDescriptor(
						UploadsService.prototype,
						'admitPublication'
					);
					const original = descriptor?.value;
					if (original === undefined) {
						throw new Error('Missing ordinary admission');
					}
					vi.spyOn(
						UploadsService.prototype,
						'admitPublication'
					).mockImplementationOnce(async function (
						this: UploadsService,
						...arguments_
					) {
						await original.apply(this, arguments_);
						throw new Error(
							'interrupted after ordinary admission before commit or ensure receipt'
						);
					});
				}
				const interrupted = await call(
					destination,
					'/ensure',
					f.token,
					f.request
				);
				expect(interrupted.status).toBe(500);
				vi.restoreAllMocks();
				const stopped = await snapshot();
				const pin = stopped.admissions[0];
				if (pin === undefined) {
					throw new Error('Missing durable pin');
				}
				expect(stopped.admissions).toEqual([
					{
						operationId: pin.operationId,
						destinationKind: 'named',
						destinationName: destination.name,
						cacheId: stopped.cache.id,
						cacheGeneration: 1,
						canonicalJson: JSON.stringify(f.request),
						pushId: pin.pushId,
						expiresAt: new Date(
							Math.floor((startedAt + 86_400_000) / 1000) * 1000
						).toISOString(),
						pruneAfter: new Date(
							Math.floor((startedAt + 86_400_000) / 1000) * 1000 +
								publicationCleanupMarginMs
						).toISOString()
					}
				]);
				expect(stopped.receipts).toEqual([]);
				expect(stopped.grace).toEqual([]);
				if (stage === 'pin-only') {
					expect(stopped.mappings).toEqual([]);
					expect(stopped.ordinary).toEqual([]);
					expect(stopped.pending).toEqual([]);
				} else {
					const metadata = uploadPathNegotiationSchema.parse({
						storePathHash: StorePath.hash(f.result.storePath),
						storePath: f.request.source.result.storePath,
						narHash: f.request.source.result.narHash,
						narSize: blob.narSize,
						references: [`${StorePath.hash(f.result.storePath)}-result`]
					});
					const identity = await publicationIdentity({
						tenant: fixtureTenant,
						cache: destination,
						cacheGeneration: f.request.expectedDestinationGeneration,
						pushId: pin.pushId,
						metadata
					});
					const graceDecisionJson = JSON.stringify({
						reportsGrace: true,
						graceSeconds: 7200,
						retentionEpoch: 0,
						publicationId: identity.id,
						recoveryDeadline: pin.expiresAt
					});
					expect(stopped.ordinary).toEqual([
						{
							id: identity.id,
							cacheId: stopped.cache.id,
							cacheGeneration: 1,
							pushId: pin.pushId,
							canonicalJson: identity.canonical,
							acceptedAt: new Date(startedAt).toISOString(),
							pushExpiresAt: pin.expiresAt,
							recoveryDeadline: pin.expiresAt,
							pruneAfter: pin.pruneAfter,
							blobJson: sqlNull,
							graceDecisionJson,
							graceDeadline: sqlNull,
							rootExpiresAt: sqlNull,
							state: 'accepted',
							resultJson: sqlNull,
							manifestOperationId: pin.operationId
						}
					]);
					expect(stopped.pending).toEqual([
						{
							id: identity.id,
							acceptedSequence,
							acceptedExpiresAt: pin.expiresAt,
							commitStartedSequence: sqlNull,
							cacheId: stopped.cache.id,
							retentionEpoch: 0,
							narHash: f.request.source.result.narHash,
							r2Key: narObjectKey(f.request.source.result.narHash),
							metadataJson: JSON.stringify({
								storePathHash: metadata.storePathHash,
								storePath: metadata.storePath,
								narHash: metadata.narHash,
								narSize: blob.narSize,
								references: metadata.references,
								fileHash: blob.fileHash,
								fileSize: blob.fileSize,
								compression: 'zstd'
							}),
							recoveryDeadline: pin.expiresAt,
							createdAt: new Date(startedAt).toISOString(),
							expiresAt: pin.expiresAt,
							verdict: sqlNull,
							settleFailures: 0,
							settleRetryAfter: sqlNull,
							lastSettleError: sqlNull,
							retryStartedActiveMs: sqlNull,
							settleExhaustion: sqlNull,
							narRefreshPending: false,
							sessionId: sqlNull,
							claimedAt: sqlNull,
							claimOwner: sqlNull,
							commitReleased: false,
							graceDecisionJson,
							attachRootName: sqlNull,
							recordedVerdictJson: sqlNull,
							declaredFileHash: sqlNull,
							declaredFileSize: sqlNull,
							committedAt: sqlNull,
							promotionJson: sqlNull
						}
					]);
					const ordinal = await runInDurableObject(
						fixtureWorkerServer(),
						(instance) =>
							instance.context.db
								.select()
								.from(schema.publicationManifestMembers)
								.where(
									and(
										eq(
											schema.publicationManifestMembers.digest,
											f.request.source.digest
										),
										eq(
											schema.publicationManifestMembers.storePath,
											f.request.source.result.storePath
										)
									)
								)
								.get()?.ordinal
					);
					expect(stopped.mappings).toEqual([
						{
							operationId: pin.operationId,
							page: ordinal,
							payloadDigest: identity.id,
							payloadJson: JSON.stringify({
								kind: 'ensure-member-admission',
								storePath: f.result.storePath,
								publicationId: identity.id
							})
						}
					]);
				}
				vi.setSystemTime(startedAt + 60_000);
				await configureGrace(3600);
				const winner = await complete(destination, {
					...f,
					request: publicationEnsureRequestSchema.parse({
						...f.request,
						requestId: createPublicationRequestId()
					})
				});
				const expected = {
					kind: 'complete' as const,
					association: 'existing' as const,
					publication: winner.publication
				};
				const beforeRecovery = await snapshot();
				expect(beforeRecovery.receipts).toEqual([]);
				expect(beforeRecovery.admissions).toEqual(stopped.admissions);
				expect(beforeRecovery.mappings).toEqual(stopped.mappings);
				expect(beforeRecovery.ordinary).toEqual(stopped.ordinary);
				expect(beforeRecovery.grace).toEqual([
					{
						cacheId: stopped.cache.id,
						storePathHash: StorePath.hash(f.result.storePath),
						retainUntil: new Date(startedAt + 60_000 + 3_600_000).toISOString()
					},
					{
						cacheId: stopped.cache.id,
						storePathHash: StorePath.hash(f.child.storePath),
						retainUntil: new Date(startedAt + 60_000 + 3_600_000).toISOString()
					}
				]);
				vi.setSystemTime(startedAt + 120_000);
				await configureGrace(10_800);
				const retention = vi.spyOn(
					RetentionService.prototype,
					'extendGraceDeadlines'
				);
				if (stage === 'ordinary-failed' || stage === 'ordinary-expired') {
					await runInDurableObject(fixtureWorkerServer(), (instance) => {
						const ordinary = stopped.ordinary[0];
						if (ordinary === undefined) {
							throw new Error('Missing ordinary admission');
						}
						new PublicationStore(instance.context).finish(
							ordinary.id,
							stage === 'ordinary-failed' ? 'failed' : 'expired'
						);
					});
					const terminal = await snapshot();
					for (const offset of [120_000, 180_000]) {
						vi.setSystemTime(startedAt + offset);
						const replay = await call(
							destination,
							'/ensure',
							f.token,
							f.request
						);
						expect(replay.status).toBe(stage === 'ordinary-failed' ? 409 : 503);
						expect(await snapshot()).toEqual(terminal);
					}
					expect(retention).not.toHaveBeenCalled();
					return;
				}
				const recovered = await call(
					destination,
					'/ensure',
					f.token,
					f.request
				);
				expect(recovered.status).toBe(200);
				expect(
					publicationEnsureResponseSchema.parse(await recovered.json())
				).toEqual(expected);
				const settled = await snapshot();
				const deadline = new Date(
					startedAt + 120_000 + (stage === 'pin-only' ? 10_800_000 : 7_200_000)
				).toISOString();
				expect(settled.grace).toEqual([
					{
						cacheId: stopped.cache.id,
						storePathHash: StorePath.hash(f.result.storePath),
						retainUntil: deadline
					},
					beforeRecovery.grace[1]
				]);
				expect(retention).toHaveBeenCalledTimes(1);
				expect(
					retention.mock.calls.map(([, hashes, retainUntil]) => ({
						hashes,
						retainUntil
					}))
				).toEqual([
					{
						hashes: [StorePath.hash(f.result.storePath)],
						retainUntil: deadline
					}
				]);
				expect(settled.admissions).toEqual(stopped.admissions);
				expect(settled.mappings).toEqual(stopped.mappings);
				expect(settled.pending).toEqual([]);
				expect(settled.receipts).toEqual([
					{
						id: pin.operationId,
						requestId: f.request.requestId,
						kind: 'ensure',
						cacheId: stopped.cache.id,
						cacheGeneration: 1,
						canonicalJson: JSON.stringify(f.request),
						sourceJson: JSON.stringify(f.request),
						resultIdentityJson: JSON.stringify(winner.publication.result),
						origin: f.request.source.origin,
						expectedCount: f.request.source.memberCount,
						nextPage: 0,
						cursor: 0,
						phase: 'publishing',
						candidateDigest: f.request.source.digest,
						progressJson: JSON.stringify({ phase: 'result' }),
						state: 'complete',
						expiresAt: pin.expiresAt,
						resultJson: JSON.stringify(expected),
						failureJson: sqlNull
					}
				]);
				if (stage === 'pin-only') {
					expect(settled.ordinary).toEqual([]);
				} else {
					const original = stopped.ordinary[0];
					expect(settled.ordinary).toEqual([
						{
							...original,
							state: 'servable',
							graceDeadline: deadline,
							resultJson: JSON.stringify({
								storePathHash: StorePath.hash(f.result.storePath),
								narHash: f.result.narHash,
								generation: winner.publication.result.generation
							})
						}
					]);
				}
				vi.setSystemTime(startedAt + 180_000);
				await configureGrace(14_400);
				const replay = await call(destination, '/ensure', f.token, f.request);
				expect(replay.status).toBe(200);
				expect(
					publicationEnsureResponseSchema.parse(await replay.json())
				).toEqual(expected);
				expect(await snapshot()).toEqual(settled);
				expect(retention).toHaveBeenCalledTimes(1);
			}, fixtureWorkerServer());
		}
	);

	it('recovers an accepted pre-operation crash with an aged client timestamp until the original admission deadline', async () => {
		const f = await fixture();
		const destination = namedCache('aged-accepted-pin');
		await putWorkerTestCache(f.token, destination);
		const configured = await authorisedWorkerFetch(
			`/caches/${destination.name}`,
			f.token,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'set-grace', graceSeconds: 3600 })
			}
		);
		expect(configured.status).toBe(200);
		vi.setSystemTime(Date.now() + 86_340_000);
		let token = await initialiseViaWorker();
		const descriptor:
			| TypedPropertyDescriptor<ProductionPublicationManifestPublisher['admit']>
			| undefined = Object.getOwnPropertyDescriptor(
			ProductionPublicationManifestPublisher.prototype,
			'admit'
		);
		const original = descriptor?.value;
		if (original === undefined) {
			throw new Error('Missing admission');
		}
		const admission = vi
			.spyOn(ProductionPublicationManifestPublisher.prototype, 'admit')
			.mockImplementationOnce(async function (
				this: ProductionPublicationManifestPublisher,
				input
			) {
				await original.call(this, input);
				throw new Error('crash after accepted result before ensure receipt');
			});
		const interrupted = await call(destination, '/ensure', token, f.request);
		expect(interrupted.status).toBe(500);
		admission.mockRestore();
		const pinned = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.where(
							eq(
								schema.publicationManifestOperations.requestId,
								f.request.requestId
							)
						)
						.all()
				).toHaveLength(0);
				const row = instance.context.db
					.select()
					.from(schema.publicationManifestAdmissions)
					.all()
					.find(
						(row) =>
							publicationEnsureRequestSchema.parse(
								JSON.parse(row.canonicalJson)
							).requestId === f.request.requestId
					);
				if (row === undefined) {
					throw new Error('Missing pin');
				}
				expect(
					instance.context.db
						.select()
						.from(schema.publicationOperations)
						.all()
						.filter((op) => op.pushId === row.pushId)
						.map((op) => op.state)
				).toEqual(['servable']);
				return row;
			}
		);
		const originalGrace = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const cache = instance.context.cacheRepository.require(destination);
				const hash = StorePath.hash(f.request.source.result.storePath);
				return instance.context.db
					.select()
					.from(schema.retentionGrace)
					.where(
						and(
							eq(schema.retentionGrace.cacheId, cache.id),
							eq(schema.retentionGrace.storePathHash, hash)
						)
					)
					.get();
			}
		);
		expect(originalGrace).toBeDefined();
		vi.setSystemTime(Date.now() + 120_000);
		token = await initialiseViaWorker();
		const completed = await complete(destination, { ...f, token });
		const replay = await call(destination, '/ensure', token, f.request);
		expect(replay.status).toBe(200);
		expect(publicationEnsureResponseSchema.parse(await replay.json())).toEqual(
			completed
		);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const receipt = instance.context.db
				.select()
				.from(schema.publicationManifestOperations)
				.where(
					eq(
						schema.publicationManifestOperations.requestId,
						f.request.requestId
					)
				)
				.get();
			const cache = instance.context.cacheRepository.require(destination);
			const hash = StorePath.hash(f.request.source.result.storePath);
			const recoveredGrace = instance.context.db
				.select()
				.from(schema.retentionGrace)
				.where(
					and(
						eq(schema.retentionGrace.cacheId, cache.id),
						eq(schema.retentionGrace.storePathHash, hash)
					)
				)
				.get();
			expect(recoveredGrace).toEqual(originalGrace);
			expect(receipt?.expiresAt).toBe(pinned.expiresAt);
			expect(
				instance.context.db
					.select()
					.from(schema.publicationManifestAdmissions)
					.where(
						eq(
							schema.publicationManifestAdmissions.operationId,
							pinned.operationId
						)
					)
					.get()
			).toEqual(pinned);
		});
	});

	it('shares the result admission with its nonzero canonical ordinal replay', async () => {
		const f = await fixture();
		const members = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const cache = instance.context.cacheRepository.require(f.source);
				return instance.context.db
					.select()
					.from(schema.narInfos)
					.where(eq(schema.narInfos.cacheId, cache.id))
					.all()
					.filter(
						(row) =>
							row.storePath === f.result.storePath ||
							row.storePath === f.child.storePath
					)
					.map((row) => ({
						storePath: row.storePath,
						narHash: row.narHash,
						generation: row.generation
					}));
			}
		);
		const result = members.find(
			(member) => member.storePath === f.child.storePath
		);
		if (result === undefined) {
			throw new Error('Missing child result');
		}
		const beginResponse = await call(f.source, '/captures', f.token, {
			result,
			requestId: createPublicationRequestId(),
			expectedCacheGeneration: 1,
			origin: 'build-selection',
			memberCount: 2
		});
		expect(beginResponse.status).toBe(200);
		const begin = publicationCaptureBeginResponseSchema.parse(
			await beginResponse.json()
		);
		if (begin.kind !== 'staging') {
			throw new Error('Expected child capture');
		}
		const pageResponse = await call(
			f.source,
			`/captures/${begin.operationId}/pages/0`,
			f.token,
			{ members },
			'PUT'
		);
		expect(pageResponse.status).toBe(200);
		for (let step = 0; step < 12; step += 1) {
			const sealedResponse = await call(
				f.source,
				`/captures/${begin.operationId}/seal`,
				f.token,
				{}
			);
			const sealed = publicationCaptureSealResponseSchema.parse(
				await sealedResponse.json()
			);
			if (sealed.kind !== 'captured') {
				continue;
			}
			const request = publicationEnsureRequestSchema.parse({
				...f.request,
				requestId: createPublicationRequestId(),
				source: sealed.publication
			});
			await complete(namedCache('nonzero-result-ordinal'), { ...f, request });
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const admission = instance.context.db
					.select()
					.from(schema.publicationManifestAdmissions)
					.all()
					.find(
						(row) =>
							publicationEnsureRequestSchema.parse(
								JSON.parse(row.canonicalJson)
							).requestId === request.requestId
					);
				if (admission === undefined) {
					throw new Error('Missing admission');
				}
				const pages = instance.context.db
					.select()
					.from(schema.publicationManifestOperationPages)
					.where(
						eq(
							schema.publicationManifestOperationPages.operationId,
							admission.operationId
						)
					)
					.all();
				expect(pages).toHaveLength(2);
				expect(
					pages.find(
						(page) =>
							ensureMemberAdmissionSchema.parse(JSON.parse(page.payloadJson))
								.storePath === result.storePath
					)?.page
				).toBe(1);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationOperations)
						.all()
						.filter((row) => row.pushId === admission.pushId)
				).toHaveLength(2);
			});
			return;
		}
		throw new Error('Child capture did not converge');
	});

	it('bounds real foreground publication steps at 64 and resumes the same request', async () => {
		const f = await fixture(undefined, 'public', 66);
		const destination = namedCache('bounded-foreground');
		const publisher = vi.spyOn(
			ProductionPublicationManifestPublisher.prototype,
			'publish'
		);
		const first = await call(destination, '/ensure', f.token, f.request);
		expect(first.status, await first.clone().text()).toBe(200);
		expect(publicationEnsureResponseSchema.parse(await first.json()).kind).toBe(
			'pending'
		);
		expect(publisher.mock.calls.length).toBeGreaterThan(1);
		expect(publisher.mock.calls.length).toBeLessThanOrEqual(64);
		publisher.mockRestore();
		await complete(destination, f);
	});

	it.each([defaultCache(), namedCache('manifest-capability')])(
		'advertises supported manifests only on successful accepted credential negotiation: %j',
		async (cache) => {
			const token = await initialiseViaWorker();
			const response = await gatewayFetch(
				`${prefix(cache)}/uploads/credential`,
				token,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						[acceptCapabilitiesHeader]: `${publicationCapability},publication-manifests-v1`
					},
					body: '{}'
				}
			);
			expect(response.status).toBe(200);
			expect(
				new Set(response.headers.get(uploadCapabilitiesHeader)?.split(','))
			).toEqual(new Set([publicationCapability, 'publication-manifests-v1']));
		}
	);

	it('looks up an absent own destination without registration, then promotes an authorised foreign source', async () => {
		const f = await fixture();
		const destination = namedCache('brand-new-lookup');
		const limited = await issueWorkerSignedToken(
			authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					cache: destination,
					actions: ['upload:commit']
				}
			])
		);
		const missing = await call(destination, '/lookup', limited, {
			source: { cache: destination },
			results: [{ storePath: f.result.storePath }]
		});
		expect(missing.status).toBe(200);
		expect(
			publicationLookupResponseSchema.parse(await missing.json()).entries
		).toEqual([{ kind: 'unavailable', storePath: f.result.storePath }]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			expect(
				instance.context.cacheRepository.resolve(destination)
			).toBeUndefined();
		});
		const fenced = await call(destination, '/lookup', limited, {
			source: { cache: destination, expectedCacheGeneration: 1 },
			results: [{ storePath: f.result.storePath }]
		});
		expect(fenced.status).toBe(409);
		const foreign = await call(destination, '/lookup', limited, {
			source: { cache: namedCache('absent-foreign') },
			results: [{ storePath: f.result.storePath }]
		});
		expect(foreign.status).toBe(409);
		const source = await call(destination, '/lookup', limited, {
			source: { cache: f.source },
			results: [{ storePath: f.result.storePath }]
		});
		expect(source.status).toBe(200);
		const promotion = await complete(destination, { ...f, token: limited });
		expect(promotion.kind).toBe('complete');
	});

	it('protects settled cold members only while pending, with zero grace and GC before final root attachment', async () => {
		const f = await fixture();
		const destination = namedCache('gc-cold-members');
		const prepared = await authorisedWorkerFetch(
			`${prefix(destination)}/uploads`,
			f.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					pushId: await testPushIdFor(fixtureTenant),
					paths: [],
					attachRoot: {
						name: 'run/gc',
						retention: { kind: 'duration', seconds: 3600 }
					}
				})
			}
		);
		expect(prepared.status).toBe(200);
		const grace = await authorisedWorkerFetch(
			`/caches/${destination.name}`,
			f.token,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'set-grace', graceSeconds: 0 })
			}
		);
		expect(grace.status).toBe(200);
		const request = publicationEnsureRequestSchema.parse({
			...f.request,
			runRoot: 'run/gc'
		});
		const observed = new Set<string>();
		const descriptor:
			| TypedPropertyDescriptor<
					ProductionPublicationManifestPublisher['publish']
			  >
			| undefined = Object.getOwnPropertyDescriptor(
			ProductionPublicationManifestPublisher.prototype,
			'publish'
		);
		const original = descriptor?.value;
		if (original === undefined) {
			throw new Error('Missing production publisher');
		}
		const spy = vi.spyOn(
			ProductionPublicationManifestPublisher.prototype,
			'publish'
		);
		spy.mockImplementation(async function (
			this: ProductionPublicationManifestPublisher,
			input
		) {
			const outcome = await original.call(this, input);
			if (
				outcome.kind !== 'accepted' ||
				observed.has(outcome.result.storePath)
			) {
				return outcome;
			}
			observed.add(outcome.result.storePath);
			const gc = await authorisedWorkerFetch(
				`${prefix(destination)}/gc`,
				f.token,
				{ method: 'POST' }
			);
			expect(gc.status).toBe(200);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(destination);
				const paths = instance.context.db
					.select()
					.from(schema.narInfos)
					.where(eq(schema.narInfos.cacheId, cache.id))
					.all()
					.map((row) => row.storePath);
				expect(paths).toContain(outcome.result.storePath);
				expect(paths).toContain(f.result.storePath);
				expect(
					instance.context.db
						.select()
						.from(schema.retentionRootTargets)
						.where(eq(schema.retentionRootTargets.cacheId, cache.id))
						.all()
				).toHaveLength(0);
				expect(
					instance.context.db
						.select()
						.from(schema.retentionGrace)
						.where(eq(schema.retentionGrace.cacheId, cache.id))
						.all()
				).toHaveLength(0);
			});
			return outcome;
		});
		await complete(destination, { ...f, request });
		spy.mockRestore();
		expect(observed).toEqual(new Set([f.child.storePath]));
		const retained = await authorisedWorkerFetch(
			`${prefix(destination)}/gc`,
			f.token,
			{ method: 'POST' }
		);
		expect(retained.status).toBe(200);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(destination);
			expect(
				instance.context.db
					.select()
					.from(schema.narInfos)
					.where(eq(schema.narInfos.cacheId, cache.id))
					.all()
			).toHaveLength(2);
		});
		const unroot = await authorisedWorkerFetch(
			`${prefix(destination)}/roots/${encodeURIComponent('run/gc')}`,
			f.token,
			{ method: 'DELETE' }
		);
		expect(unroot.status).toBe(200);
		const collected = await authorisedWorkerFetch(
			`${prefix(destination)}/gc`,
			f.token,
			{ method: 'POST' }
		);
		expect(collected.status).toBe(200);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(destination);
			expect(
				instance.context.db
					.select()
					.from(schema.narInfos)
					.where(eq(schema.narInfos.cacheId, cache.id))
					.all()
			).toHaveLength(0);
		});
	});

	it.each(['failed', 'expired'] as const)(
		'ends transient deletion protection when manifest work is %s',
		async (state) => {
			const f = await fixture();
			const destination = namedCache(`inactive-${state}`);
			await putWorkerTestCache(f.token, destination);
			const configured = await authorisedWorkerFetch(
				`/caches/${destination.name}`,
				f.token,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: 'set-grace', graceSeconds: 0 })
				}
			);
			expect(configured.status).toBe(200);
			const spy = vi
				.spyOn(ProductionPublicationManifestPublisher.prototype, 'publish')
				.mockRejectedValueOnce(
					new Error('interrupt after normal result acceptance')
				);
			const pending = await call(destination, '/ensure', f.token, f.request);
			expect(pending.status).toBe(500);
			spy.mockRestore();
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(destination);
				expect(
					instance.context.db
						.select()
						.from(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, cache.id))
						.all()
				).toHaveLength(1);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestWorkHolds)
						.where(eq(schema.publicationManifestWorkHolds.cacheId, cache.id))
						.all()
				).toHaveLength(1);
				if (state === 'failed') {
					instance.context.db
						.update(schema.publicationManifestOperations)
						.set({ state: 'failed' })
						.where(
							eq(
								schema.publicationManifestOperations.requestId,
								f.request.requestId
							)
						)
						.run();
				}
			});
			if (state === 'expired') {
				vi.setSystemTime(Date.now() + 86_400_001);
			}
			const token = await initialiseViaWorker();
			const gc = await authorisedWorkerFetch(
				`${prefix(destination)}/gc`,
				token,
				{ method: 'POST' }
			);
			expect(gc.status).toBe(200);
			await runInDurableObject(fixtureWorkerServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(destination);
				expect(
					instance.context.db
						.select()
						.from(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, cache.id))
						.all()
				).toHaveLength(0);
			});
		}
	);

	it('captures and observes through the default-cache routes before foreign promotion', async () => {
		const f = await fixture(defaultCache());
		await complete(namedCache('default-source-promotion'), f);
	});

	it('keeps the normal first result grace event sticky through cold finalisation', async () => {
		const f = await fixture();
		const destination = namedCache('cold-grace');
		await putWorkerTestCache(f.token, destination);
		const configured = await authorisedWorkerFetch(
			`/caches/${destination.name}`,
			f.token,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'set-grace', graceSeconds: 3600 })
			}
		);
		expect(configured.status).toBe(200);
		const descriptor:
			| TypedPropertyDescriptor<
					ProductionPublicationManifestPublisher['publish']
			  >
			| undefined = Object.getOwnPropertyDescriptor(
			ProductionPublicationManifestPublisher.prototype,
			'publish'
		);
		const original = descriptor?.value;
		if (original === undefined) {
			throw new Error('Missing publisher');
		}
		let isAdvanced = false;
		const spy = vi
			.spyOn(ProductionPublicationManifestPublisher.prototype, 'publish')
			.mockImplementation(async function (
				this: ProductionPublicationManifestPublisher,
				input
			) {
				const response = await original.call(this, input);
				if (!isAdvanced && response.kind === 'accepted') {
					isAdvanced = true;
					vi.setSystemTime(Date.now() + 60_000);
				}
				return response;
			});
		await complete(destination, f);
		spy.mockRestore();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const admission = instance.context.db
				.select()
				.from(schema.publicationManifestAdmissions)
				.all()
				.find(
					(row) =>
						publicationEnsureRequestSchema.parse(JSON.parse(row.canonicalJson))
							.requestId === f.request.requestId
				);
			if (admission === undefined) {
				throw new Error('Missing admission');
			}
			const cache = instance.context.cacheRepository.require(destination);
			const operations = instance.context.db
				.select()
				.from(schema.publicationOperations)
				.all()
				.filter((row) => row.pushId === admission.pushId);
			const hash = StorePath.hash(f.request.source.result.storePath);
			const grace = instance.context.db
				.select()
				.from(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cacheId, cache.id))
				.all()
				.find((row) => row.storePathHash === hash);
			expect(operations).toHaveLength(2);
			const resultPage = instance.context.db
				.select()
				.from(schema.publicationManifestOperationPages)
				.where(
					eq(
						schema.publicationManifestOperationPages.operationId,
						admission.operationId
					)
				)
				.all()
				.find(
					(page) =>
						ensureMemberAdmissionSchema.parse(JSON.parse(page.payloadJson))
							.storePath === f.result.storePath
				);
			if (resultPage === undefined) {
				throw new Error('Missing result mapping');
			}
			const publication = operations.find(
				(row) => row.id === resultPage.payloadDigest
			);
			expect(grace?.retainUntil).toBe(publication?.graceDeadline);
			expect(publication?.graceDeadline).toBe(
				new Date(Date.now() + 3_540_000).toISOString()
			);
		});
	});

	it('refreshes finite grace once for a new warm UUID, not for replay or cold finalisation', async () => {
		const f = await fixture();
		const destination = namedCache('warm-grace');
		await complete(destination, f);
		const grace = await authorisedWorkerFetch(
			`/caches/${destination.name}`,
			f.token,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'set-grace', graceSeconds: 3600 })
			}
		);
		expect(grace.status).toBe(200);
		const request = publicationEnsureRequestSchema.parse({
			...f.request,
			requestId: createPublicationRequestId()
		});
		await complete(destination, { ...f, request });
		const first = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.select()
				.from(schema.retentionGrace)
				.where(
					eq(
						schema.retentionGrace.cacheId,
						instance.context.cacheRepository.require(destination).id
					)
				)
				.all()
		);
		expect(first).toHaveLength(1);
		expect(first[0]?.storePathHash).toBe(
			StorePath.hash(f.request.source.result.storePath)
		);
		vi.setSystemTime(Date.now() + 60_000);
		await complete(destination, { ...f, request });
		const replay = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.select()
				.from(schema.retentionGrace)
				.where(
					eq(
						schema.retentionGrace.cacheId,
						instance.context.cacheRepository.require(destination).id
					)
				)
				.all()
		);
		expect(replay).toEqual(first);
		await complete(destination, {
			...f,
			request: publicationEnsureRequestSchema.parse({
				...request,
				requestId: createPublicationRequestId()
			})
		});
		const fresh = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.select()
				.from(schema.retentionGrace)
				.where(
					eq(
						schema.retentionGrace.cacheId,
						instance.context.cacheRepository.require(destination).id
					)
				)
				.all()
		);
		const initialDeadline = Date.parse(first[0]?.retainUntil ?? '');
		expect(fresh[0]?.retainUntil).toBe(
			new Date(initialDeadline + 60_000).toISOString()
		);
	});

	it('keeps normal charge and lease accounting stable on replay', async () => {
		const f = await fixture();
		const destination = namedCache('accounting');
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const before = await database
			.select()
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
			.get();
		await complete(destination, f);
		const after = await database
			.select()
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
			.get();
		expect(after?.bytes).toBe(before?.bytes);
		expect(after?.blobs).toBe(before?.blobs);
		expect(after?.narinfos).toBe((before?.narinfos ?? 0) + 2);
		await complete(destination, f);
		expect(
			await database
				.select()
				.from(d1Schema.tenantUsage)
				.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
				.get()
		).toEqual(after);
	});

	it('status observes pending manifest work; a foreground resubmission advances it', async () => {
		const f = await fixture();
		const destination = namedCache('pending-foreground');
		const spy = vi
			.spyOn(ProductionPublicationManifestPublisher.prototype, 'publish')
			.mockRejectedValueOnce(new Error('interrupted foreground progression'));
		const interrupted = await call(destination, '/ensure', f.token, f.request);
		expect(interrupted.status).toBe(500);
		spy.mockRestore();
		const operation = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) =>
				instance.context.db
					.select()
					.from(schema.publicationManifestOperations)
					.where(
						eq(
							schema.publicationManifestOperations.requestId,
							f.request.requestId
						)
					)
					.get()
		);
		if (operation === undefined) {
			throw new Error('Missing pending ensure');
		}
		const observe = vi.spyOn(UploadsService.prototype, 'admitPublication');
		const status = await call(
			destination,
			`/operations/${operation.id}`,
			f.token,
			undefined,
			'GET'
		);
		expect(status.status).toBe(200);
		expect(
			publicationStatusResponseSchema.parse(await status.json()).kind
		).toBe('pending');
		expect(observe).not.toHaveBeenCalled();
		observe.mockRestore();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			expect(
				instance.context.db
					.select()
					.from(schema.publicationManifestOperations)
					.where(eq(schema.publicationManifestOperations.id, operation.id))
					.get()
			).toEqual(operation);
		});
		const completed = await complete(destination, f);
		expect(completed.kind).toBe('complete');
	});

	it('uses only root:attach for the existing prepared run root and attaches just the result', async () => {
		const f = await fixture();
		const destination = namedCache('run-root');
		const prepared = await authorisedWorkerFetch(
			`${prefix(destination)}/uploads`,
			f.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					pushId: await testPushIdFor(fixtureTenant),
					paths: [],
					attachRoot: {
						name: 'run/production',
						retention: { kind: 'duration', seconds: 3600 }
					}
				})
			}
		);
		expect(prepared.status).toBe(200);
		const rootBefore = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) =>
				instance.context.db
					.select()
					.from(schema.retentionRoots)
					.where(
						eq(
							schema.retentionRoots.cacheId,
							instance.context.cacheRepository.require(destination).id
						)
					)
					.get()
		);
		const token = await issueWorkerSignedToken(
			authorizationDetailsSchema.parse([
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
			])
		);
		const request = publicationEnsureRequestSchema.parse({
			...f.request,
			runRoot: 'run/production'
		});
		await complete(destination, { ...f, token, request });
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(destination);
			expect(
				instance.context.db
					.select()
					.from(schema.retentionRoots)
					.where(eq(schema.retentionRoots.cacheId, cache.id))
					.get()
			).toEqual(rootBefore);
			expect(
				instance.context.db
					.select()
					.from(schema.retentionRootTargets)
					.where(eq(schema.retentionRootTargets.cacheId, cache.id))
					.all()
					.map((row) => row.storePath)
			).toEqual([f.result.storePath]);
		});
	});

	it('honours private view membership and current selector revision without direct source grants', async () => {
		const f = await fixture(namedCache('view-source'), 'private');
		await setView(
			[{ kind: 'named', name: 'view-source' }],
			'production-view',
			'private'
		);
		const destination = namedCache('view-destination');
		const token = await issueWorkerSignedToken(
			authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					cache: destination,
					actions: ['upload:commit']
				},
				{
					type: 'cupboard_view',
					view: 'production-view',
					actions: ['view:content-read']
				}
			])
		);
		const lookup = await call(destination, '/lookup', token, {
			source: { selector: { view: 'production-view' } },
			results: [{ storePath: f.result.storePath }]
		});
		expect(lookup.status).toBe(200);
		const found = publicationLookupResponseSchema.parse(await lookup.json());
		const request = publicationEnsureRequestSchema.parse({
			...f.request,
			sourceSelector: found.sourceSelector
		});
		await complete(destination, { ...f, token, request });
		await setView(
			[{ kind: 'named', name: 'other-private' }],
			'production-view',
			'private'
		);
		const stale = await call(destination, '/ensure', token, request);
		expect(stale.status).toBe(409);
	});

	it('refuses expired pinned admission without replacing its deadline or push', async () => {
		const f = await fixture();
		const destination = namedCache('expired-pin');
		const spy = vi
			.spyOn(UploadsService.prototype, 'admitPublication')
			.mockRejectedValueOnce(new Error('crash'));
		await call(destination, '/ensure', f.token, f.request);
		spy.mockRestore();
		const pinned = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const row = instance.context.db
					.select()
					.from(schema.publicationManifestAdmissions)
					.all()
					.find(
						(row) =>
							publicationEnsureRequestSchema.parse(
								JSON.parse(row.canonicalJson)
							).requestId === f.request.requestId
					);
				if (row === undefined) {
					throw new Error('Missing pin');
				}
				const expiredAt = isoTimestamp(new Date(Date.now() - 1000));
				instance.context.db
					.update(schema.publicationManifestAdmissions)
					.set({ expiresAt: expiredAt })
					.where(
						eq(
							schema.publicationManifestAdmissions.operationId,
							row.operationId
						)
					)
					.run();
				return row;
			}
		);
		const expired = await call(destination, '/ensure', f.token, f.request);
		expect(expired.status).toBe(410);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			expect(
				instance.context.db
					.select()
					.from(schema.publicationManifestAdmissions)
					.where(
						eq(
							schema.publicationManifestAdmissions.operationId,
							pinned.operationId
						)
					)
					.get()?.pushId
			).toBe(pinned.pushId);
		});
	});

	it('pins before ordinary admission; reset replays identical intent and rejects changed requests without a second push', async () => {
		const f = await fixture();
		const destination = namedCache('crash');
		const spy = vi
			.spyOn(UploadsService.prototype, 'admitPublication')
			.mockRejectedValueOnce(new Error('crash after manifest pin'));
		const crashed = await call(destination, '/ensure', f.token, f.request);
		expect(crashed.status).toBe(500);
		spy.mockRestore();
		const pinned = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.where(
							eq(
								schema.publicationManifestOperations.requestId,
								f.request.requestId
							)
						)
						.all()
				).toHaveLength(0);
				const rows = instance.context.db
					.select()
					.from(schema.publicationManifestAdmissions)
					.all()
					.filter(
						(row) =>
							publicationEnsureRequestSchema.parse(
								JSON.parse(row.canonicalJson)
							).requestId === f.request.requestId
					);
				expect(rows).toHaveLength(1);
				return rows[0];
			}
		);
		await restartTestServers();
		const changedResponse = await call(destination, '/ensure', f.token, {
			...f.request,
			source: { ...f.request.source, origin: 'legacy-selection' }
		});
		expect(changedResponse.status, await changedResponse.text()).toBe(409);
		const responses = await Promise.all([
			call(destination, '/ensure', f.token, f.request),
			call(destination, '/ensure', f.token, f.request),
			call(destination, '/ensure', f.token, {
				...f.request,
				source: { ...f.request.source, origin: 'legacy-selection' }
			})
		]);
		expect(responses.map((response) => response.status)).toEqual([
			200, 200, 409
		]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const rows = instance.context.db
				.select()
				.from(schema.publicationManifestAdmissions)
				.all()
				.filter(
					(row) =>
						publicationEnsureRequestSchema.parse(JSON.parse(row.canonicalJson))
							.requestId === f.request.requestId
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.pushId).toBe(pinned?.pushId);
			expect(rows[0]?.expiresAt).toBe(pinned?.expiresAt);
		});
	});

	it('warm reuse performs zero member admissions and observation does not advance work', async () => {
		const f = await fixture();
		const destination = namedCache('warm');
		const first = await complete(destination, f);
		expect(first.kind).toBe('complete');
		const spy = vi.spyOn(UploadsService.prototype, 'admitPublication');
		const next = await call(destination, '/ensure', f.token, {
			...f.request,
			requestId: createPublicationRequestId()
		});
		expect(next.status).toBe(200);
		expect(publicationEnsureResponseSchema.parse(await next.json()).kind).toBe(
			'complete'
		);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it.each([defaultCache(), namedCache('bounds')])(
		'rejects raw oversized whitespace before schema parsing: %j',
		async (cache) => {
			const token = await initialiseViaWorker();
			for (const suffix of [
				'/lookup',
				'/captures',
				'/ensure',
				`/captures/${crypto.randomUUID()}/pages/0`,
				`/captures/${crypto.randomUUID()}/seal`
			]) {
				const response = await gatewayFetch(
					`${prefix(cache)}/publication-results${suffix}`,
					token,
					{
						method: suffix.endsWith('/0') ? 'PUT' : 'POST',
						headers: { 'content-type': 'application/json' },
						body: `${' '.repeat(65_536)}{}`
					}
				);
				expect(response.status).toBe(413);
				const boundary = await gatewayFetch(
					`${prefix(cache)}/publication-results${suffix}`,
					token,
					{
						method: suffix.endsWith('/0') ? 'PUT' : 'POST',
						headers: { 'content-type': 'application/json' },
						body: `${' '.repeat(65_534)}{}`
					}
				);
				expect([400, 404, 409]).toContain(boundary.status);
			}
		}
	);

	it('rejects foreign private source without current read authority before pinning', async () => {
		const source = namedCache('private-source');
		const token = await initialiseViaWorker();
		const f = await fixture(source, 'private');
		const destination = namedCache('private-destination');
		const limited = await issueWorkerSignedToken(
			authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					cache: destination,
					actions: ['upload:commit']
				}
			])
		);
		const denied = await call(destination, '/ensure', limited, f.request);
		expect(denied.status).toBe(403);
		const allowed = await call(destination, '/ensure', token, f.request);
		expect(allowed.status).toBe(200);
	});

	it('refuses changed member metadata after a pre-admission crash instead of issuing a second ordinary identity', async () => {
		const f = await fixture();
		const destination = namedCache('metadata-fence');
		const spy = vi
			.spyOn(UploadsService.prototype, 'admitPublication')
			.mockRejectedValueOnce(new Error('crash'));
		await call(destination, '/ensure', f.token, f.request);
		spy.mockRestore();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(f.source);
			instance.context.db
				.update(schema.narInfos)
				.set({ narSize: sql`${schema.narInfos.narSize}+1` })
				.where(eq(schema.narInfos.cacheId, cache.id))
				.run();
		});
		const changed = await call(destination, '/ensure', f.token, f.request);
		expect(changed.status).toBe(409);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const admission = instance.context.db
				.select()
				.from(schema.publicationManifestAdmissions)
				.all()
				.find(
					(row) =>
						publicationEnsureRequestSchema.parse(JSON.parse(row.canonicalJson))
							.requestId === f.request.requestId
				);
			if (admission === undefined) {
				throw new Error('Missing pin');
			}
			expect(
				instance.context.db
					.select()
					.from(schema.publicationOperations)
					.all()
					.filter((row) => row.pushId === admission.pushId)
			).toHaveLength(0);
		});
	});

	it('fences a pinned intent against a later destination cache generation', async () => {
		const f = await fixture();
		const destination = namedCache('cache-generation-fence');
		await putWorkerTestCache(f.token, destination);
		const spy = vi
			.spyOn(UploadsService.prototype, 'admitPublication')
			.mockRejectedValueOnce(new Error('crash'));
		await call(destination, '/ensure', f.token, f.request);
		spy.mockRestore();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(destination);
			instance.context.db
				.update(schema.cacheIdentities)
				.set({ generation: cacheGenerationSchema.parse(2) })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();
		});
		const refused = await call(destination, '/ensure', f.token, f.request);
		expect(refused.status).toBe(409);
	});

	it('reclaims orphan admission pages in bounded ranges after their fixed deadline', async () => {
		const f = await fixture();
		const spy = vi
			.spyOn(UploadsService.prototype, 'admitPublication')
			.mockRejectedValueOnce(new Error('crash'));
		await call(namedCache('orphan'), '/ensure', f.token, f.request);
		spy.mockRestore();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const row = instance.context.db
				.select()
				.from(schema.publicationManifestAdmissions)
				.all()
				.find(
					(row) =>
						publicationEnsureRequestSchema.parse(JSON.parse(row.canonicalJson))
							.requestId === f.request.requestId
				);
			if (row === undefined) {
				throw new Error('Missing pin');
			}
			instance.context.db
				.update(schema.publicationManifestAdmissions)
				.set({ pruneAfter: isoTimestamp(new Date(0)) })
				.where(
					eq(schema.publicationManifestAdmissions.operationId, row.operationId)
				)
				.run();
			const cleanup = new PublicationManifestCleanup(instance.context.db);
			const now = isoTimestamp(new Date());
			expect(cleanup.hasWork(now)).toBe(true);
			withRowBudget(() => cleanup.collect(now, 1));
			expect(
				instance.context.db
					.select()
					.from(schema.publicationManifestAdmissions)
					.where(
						eq(
							schema.publicationManifestAdmissions.operationId,
							row.operationId
						)
					)
					.all()
			).toHaveLength(0);
			expect(
				instance.context.db.all(
					sql`SELECT 1 FROM publication_manifest_operation_page WHERE operation_id = ${row.operationId}`
				)
			).toHaveLength(0);
		});
	});
});
