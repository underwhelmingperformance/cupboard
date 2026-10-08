import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import {
	type CacheAccessMode,
	type CacheScope,
	narInfoGenerationSchema,
	predicateTypeSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	attestationAttachResponseSchema,
	type AttestationDecision,
	attestationDecisionSchema,
	attestationInfoResponseSchema,
	attestationListSchema,
	attestationNegotiateMaxBundles,
	attestationNegotiateResponseSchema,
	attestationUploadDecisionSchema
} from '@cupboard/protocol/attestations';
import { buildOriginPredicateType } from '@cupboard/protocol/build-origin';
import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	uploadDecisionSchema,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { sha256HexBytes } from '../crypto/crypto.ts';
import { authorisedByPathGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	AttestationPathNotFoundError,
	SharedFactsUnavailableError
} from '../errors.ts';
import {
	attestationListObjectKey,
	attestationStagingObjectKey,
	casObjectKey,
	internalOrigin,
	type R2ObjectKey
} from '../http/http.ts';
import { runReaperDemote } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	attestationReferenceRows,
	authorisedWorkerFetch,
	cacheScopedPath,
	cacheWriteGrants,
	casObjectRows,
	clearBlobStorage,
	commitSessionFromResponse,
	commitUploadViaWorker,
	currentCasObjectKey,
	currentNarObjectKey,
	fixtureWorkerServer,
	flakyD1,
	handlerFetch,
	hexBytes,
	initialiseViaWorker,
	issueTokenForTenant,
	namedCache,
	narDigestHex,
	pendingAttestationRows,
	provisionFixtureTenant,
	provisionNamedTenant,
	putNarBytes,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer,
	resolvedCache,
	restartTestServers,
	sigstoreBundleBytes,
	tenantBlobRows,
	tenantCasBlobRows,
	tenantUsageRow,
	testPushId,
	testPushIdFor,
	testServerFor,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { type MaintenanceProgress } from './alarm.ts';
import { AttestationCasService } from './attestation-cas-service.ts';
import {
	AttestationsService,
	inheritanceListSubrequests,
	inheritanceLookupSubrequests,
	inheritedBundleSubrequests
} from './attestations-service.ts';
import { fencedCasObjectDeletion } from './blob-reaper-service.ts';
import { chunk, maxBoundParameters } from './bulk.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import { ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { jsonRowList } from './json-list.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	PathReadAuthorityService,
	pathReadDemotionPendingKey
} from './path-read-authority-service.ts';
import { ProtectedInheritanceService } from './protected-inheritance-service.ts';
import { rowsRemaining, withRowBudget } from './row-budget.ts';
import { CupboardServer, maintenancePassCursorKey } from './server.ts';
import {
	subrequestsAvailable,
	subrequestSliceReserve,
	withSubrequestSlice
} from './subrequest-slice.ts';
import { UploadStateService } from './upload-state-service.ts';
import { WorkSequenceService } from './work-sequence-service.ts';

const predicateType = 'https://slsa.dev/provenance/v1';
const defaultCacheScope: CacheScope = { kind: 'default' };

// Orders by UTF-16 code unit, matching the default `<`/`>` comparison.
function compareById(left: { id: string }, right: { id: string }): number {
	if (left.id < right.id) {
		return -1;
	}

	if (left.id > right.id) {
		return 1;
	}

	return 0;
}
const orpcErrorBodySchema = z.strictObject({
	defined: z.boolean(),
	code: z.string(),
	status: z.number(),
	message: z.string(),
	data: z.unknown().optional()
});
const storePathHashCursor = { next: 0 };

function orpcErrorBodyShape(body: unknown): {
	readonly defined: boolean;
	readonly code: string;
	readonly status: number;
	readonly data: unknown;
} {
	const parsed = orpcErrorBodySchema.parse(body);

	return {
		defined: parsed.defined,
		code: parsed.code,
		status: parsed.status,
		data: parsed.data
	};
}

describe('attestation attach and reads', () => {
	beforeEach(async () => {
		vi.useRealTimers();
		await resetTestServer();
		await clearBlobStorage();
		// The scheduler delivers the alarm that a commit arms. Stop that alarm
		// from draining the inheritance queue, so that each test drains it with
		// `drainInheritance`.
		vi.spyOn(
			AttestationsService.prototype,
			'nextInheritanceAt'
		).mockReturnValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('marks an absent attestation list as uncacheable', async () => {
		await initialiseViaWorker();
		const storePathHash = uniqueStorePathHash();

		const response = await readFetch(`/attestations/${storePathHash}`);

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			cacheControl: 'no-store'
		});
	});

	it('attaches a DSSE bundle and serves descriptors from the filed edge', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();

		const attached = await attachBundle(token, metadata.storePathHash, bundle);
		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const bundleRead = await readFetch(`/attestation-bundles/${digest}`);
		const bundleBytes = new Uint8Array(await bundleRead.arrayBuffer());

		expect({
			attached,
			listStatus: list.status,
			listControl: list.headers.get('cache-control'),
			listBody: attestationListSchema.parse(await list.json()),
			bundleStatus: bundleRead.status,
			bundleControl: bundleRead.headers.get('cache-control'),
			bundleBytes: [...bundleBytes]
		}).toStrictEqual({
			attached: {
				storePathHash: metadata.storePathHash,
				digest,
				predicateType,
				status: 'attached'
			},
			listStatus: StatusCodes.OK,
			listControl: 'no-store',
			listBody: {
				attestations: [{ digest, predicateType, size: bundle.byteLength }]
			},
			bundleStatus: StatusCodes.OK,
			bundleControl: 'no-store',
			bundleBytes: [...bundle]
		});
	});

	it('requires read credentials for the attestation probe of a private named cache', async () => {
		const cache = namedCache('private-probe');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, cache, 'private');
		const nar = await verifiableNar('private-attestation-probe');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar, cache);
		const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		await attachBundle(token, metadata.storePathHash, bundle, cache);
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		const probe = (headers: Record<string, string>) =>
			readFetch(`/cache/${cache.name}/api/v1/attestation-info`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify({ storePathHashes: [metadata.storePathHash] })
			});
		const unauthorised = await probe({});
		const authorised = await probe({
			authorization: `Basic ${btoa('alice:secret')}`
		});

		expect({
			unauthorised: unauthorised.status,
			authorised: authorised.status,
			body: attestationInfoResponseSchema.parse(await authorised.json())
		}).toStrictEqual({
			unauthorised: StatusCodes.UNAUTHORIZED,
			authorised: StatusCodes.OK,
			body: {
				scopeVersion: 'cache:1:1:private:false',
				entries: [
					{
						storePathHash: metadata.storePathHash,
						status: 'found',
						narHash: metadata.narHash,
						attestations: [
							{
								digest,
								predicateType,
								size: bundle.byteLength
							}
						]
					}
				]
			}
		});
	});

	it('requires the read challenge before it reveals a missing cache', async () => {
		await initialiseViaWorker();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		const storePathHash = uniqueStorePathHash();
		const unauthorised = await readFetch(
			'/cache/absent/api/v1/attestation-info',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ storePathHashes: [storePathHash] })
			}
		);
		const authorised = await readFetch(
			'/cache/absent/api/v1/attestation-info',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Basic ${btoa('alice:secret')}`
				},
				body: JSON.stringify({ storePathHashes: [storePathHash] })
			}
		);

		expect({
			unauthorised: unauthorised.status,
			authorised: authorised.status,
			body: attestationInfoResponseSchema.parse(await authorised.json())
		}).toStrictEqual({
			unauthorised: StatusCodes.UNAUTHORIZED,
			authorised: StatusCodes.OK,
			body: {
				scopeVersion: 'cache:1:1:private:true',
				entries: [{ storePathHash, status: 'missing' }]
			}
		});
	});

	it.each(['bundles', 'caches', 'revoked', 'replaced'] as const)(
		'bounds readable inheritance lookup with 25,000 %s',
		async (shape) => {
			const { token, metadata, nar } = await committedPathBundle();
			const destination = namedCache('readable-source-scale');
			await putWorkerTestCache(token, destination);
			switch (shape) {
				case 'bundles':
				case 'revoked':
				case 'replaced': {
					await env.CUPBOARD_DB.prepare(
						`WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM source WHERE n < 25000) INSERT INTO attestation_ref_storage (tenant, cache_kind, store_path_hash, generation, predicate_type, digest) SELECT ?, 'default', ?, 0, ?, printf('%064x', n) FROM source`
					)
						.bind(fixtureTenant, metadata.storePathHash, predicateType)
						.run();
					if (shape === 'revoked') {
						await env.CUPBOARD_DB.prepare(
							'UPDATE blob_ref_storage SET readable = false WHERE tenant = ? AND store_path_hash = ?'
						)
							.bind(fixtureTenant, metadata.storePathHash)
							.run();
					} else if (shape === 'replaced') {
						await env.CUPBOARD_DB.prepare(
							'UPDATE cache_lifecycle_storage SET generation = generation + 1 WHERE tenant = ? AND cache_kind = ?'
						)
							.bind(fixtureTenant, 'default')
							.run();
					}
					break;
				}
				case 'caches': {
					const recursive =
						'WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM source WHERE n < 25000)';
					await env.CUPBOARD_DB.prepare(
						`${recursive} INSERT INTO cache_lifecycle_storage(tenant, cache_kind, cache_name, access, generation, updated_at) SELECT ?, 'named', printf('scale-cache-%08d', n), 'public', 1, ? FROM source`
					)
						.bind(fixtureTenant, isoTimestamp(new Date()))
						.run();
					await env.CUPBOARD_DB.prepare(
						`${recursive} INSERT INTO blob_ref_storage(tenant, cache_kind, cache_name, store_path_hash, generation, nar_hash, cache_generation) SELECT ?, 'named', printf('scale-cache-%08d', n), ?, 0, ?, 1 FROM source`
					)
						.bind(fixtureTenant, metadata.storePathHash, nar.narHash)
						.run();
					await env.CUPBOARD_DB.prepare(
						`${recursive} INSERT INTO attestation_ref_storage(tenant, cache_kind, cache_name, store_path_hash, generation, predicate_type, digest) SELECT ?, 'named', printf('scale-cache-%08d', n), ?, 0, ?, printf('%064x', 1) FROM source`
					)
						.bind(fixtureTenant, metadata.storePathHash, predicateType)
						.run();
					await runInDurableObject(fixtureWorkerServer(), (instance, state) => {
						state.storage.sql.exec(
							'DELETE FROM narinfo WHERE cache_id = ?',
							resolvedCache(instance.context).id
						);
						state.storage.sql.exec(
							`${recursive} INSERT INTO cache_identity(kind, name, access, priority, created_at) SELECT 'named', printf('scale-cache-%08d', n), 'public', 40, ? FROM source`,
							isoTimestamp(new Date())
						);
						state.storage.sql.exec(
							`INSERT INTO narinfo(cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) SELECT id, ?, ?, ?, 1, '[]', ? FROM cache_identity WHERE name LIKE 'scale-cache-%'`,
							metadata.storePathHash,
							metadata.storePath,
							metadata.narHash,
							isoTimestamp(new Date())
						);
					});
					break;
				}
			}

			const reads: number[] = [];
			const found: string[] = [];
			const statements: { query: string; values: unknown[] }[] = [];
			const binding: D1Database = {
				prepare: (query) => {
					const statement = env.CUPBOARD_DB.prepare(query);
					if (!query.includes('inheritance_source_reference')) {
						return statement;
					}
					const bind = statement.bind.bind(statement);
					statement.bind = (...values: unknown[]) => {
						statements.push({ query, values });
						return bind(...values);
					};
					return statement;
				},
				async batch<T>(statements: D1PreparedStatement[]) {
					const results = await env.CUPBOARD_DB.batch<T>(statements);
					reads.push(...results.map((result) => result.meta.rows_read));
					for (const result of results) {
						for (const row of result.results) {
							const parsed = z
								.object({
									digest: z.string(),
									available: z
										.union([z.boolean(), z.number()])
										.transform(Boolean)
								})
								.safeParse(row);
							if (parsed.success && parsed.data.available) {
								found.push(parsed.data.digest);
							}
						}
					}
					return results;
				},
				exec: (query) => env.CUPBOARD_DB.exec(query),
				withSession: (constraint) => env.CUPBOARD_DB.withSession(constraint),
				dump: () =>
					Promise.reject(new Error('The scale fixture does not dump D1.'))
			};
			const result = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance, state) => {
					const context = new ServerContext(state, {
						...instance.context.env,
						CUPBOARD_DB: binding
					});
					const cache = resolvedCache(context, destination);
					const source = context.db
						.select()
						.from(schema.narInfos)
						.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
						.get();
					if (source === undefined) {
						throw new Error('The scale fixture requires its committed source.');
					}
					context.db
						.insert(schema.narInfos)
						.values({ ...source, cacheId: cache.id })
						.onConflictDoNothing()
						.run();
					await attestationsFor(context).queueInheritance(
						cache,
						metadata.storePathHash,
						source.generation,
						nar.narHash
					);
					await withSubrequestSlice(
						() =>
							attestationsFor(context).inheritFromTenant(rootLogger(), {
								cache,
								storePathHash: metadata.storePathHash,
								narHash: nar.narHash,
								generation: narInfoGenerationSchema.parse(0)
							}),
						{
							subrequests:
								inheritanceLookupSubrequests + inheritanceListSubrequests,
							reserve: 0
						}
					);
					context.db
						.delete(schema.attestationInheritances)
						.where(eq(schema.attestationInheritances.cacheId, cache.id))
						.run();
					context.db
						.delete(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, cache.id))
						.run();
					return [...new Set(found)];
				}
			);
			if (shape === 'replaced') {
				await env.CUPBOARD_DB.prepare(
					'UPDATE cache_lifecycle_storage SET generation = generation - 1 WHERE tenant = ? AND cache_kind = ?'
				)
					.bind(fixtureTenant, 'default')
					.run();
			}

			const plans = await Promise.all(
				statements.map(async ({ query, values }) => {
					const explained = await env.CUPBOARD_DB.prepare(
						`EXPLAIN QUERY PLAN ${query}`
					)
						.bind(...values)
						.all();
					return z
						.array(z.object({ detail: z.string() }))
						.parse(explained.results)
						.map((row) => row.detail);
				})
			);

			expect({
				digests: result,
				reads,
				plans
			}).toStrictEqual({
				digests: Array.from(
					{ length: shape === 'caches' ? 1 : shape === 'bundles' ? 65 : 0 },
					(_, index) =>
						sha256HexDigestSchema.parse(
							(index + 1).toString(16).padStart(64, '0')
						)
				),
				reads: [shape === 'caches' ? 6 : 260, 0],
				plans: [
					[
						'CO-ROUTINE inheritance_source_reference',
						shape === 'caches'
							? 'SEARCH attestation_ref_storage USING INDEX attestation_ref_named_identity_idx (tenant=? AND cache_name=? AND store_path_hash=? AND generation=?)'
							: 'SEARCH attestation_ref_storage USING INDEX attestation_ref_default_identity_idx (tenant=? AND store_path_hash=? AND generation=?)',
						'SCAN inheritance_source_reference',
						shape === 'caches'
							? 'SEARCH blob_ref_storage USING INDEX blob_ref_named_identity_idx (tenant=? AND cache_name=? AND store_path_hash=? AND generation=?) LEFT-JOIN'
							: 'SEARCH blob_ref_storage USING INDEX blob_ref_default_identity_idx (tenant=? AND store_path_hash=? AND generation=?) LEFT-JOIN',
						'SEARCH cas_object USING INDEX sqlite_autoindex_cas_object_1 (digest=?) LEFT-JOIN',
						'SEARCH cache_lifecycle_storage USING INDEX cache_lifecycle_native_identity_idx (tenant=? AND cache_kind=? AND cache_name=?) LEFT-JOIN',
						'CORRELATED SCALAR SUBQUERY 1',
						'SEARCH destination_inheritance_reference USING COVERING INDEX attestation_ref_named_identity_idx (tenant=? AND cache_name=? AND store_path_hash=? AND generation=? AND predicate_type=? AND digest=?)',
						'CORRELATED SCALAR SUBQUERY 2',
						'SEARCH path_read_revocation USING INDEX path_read_revocation_native_identity_idx (tenant=? AND cache_kind=? AND cache_name=? AND store_path_hash=?)'
					]
				]
			});
			if (shape !== 'revoked') {
				return;
			}
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const context = instance.context;
				const cache = resolvedCache(context, destination);
				context.db
					.delete(schema.attestationInheritances)
					.where(eq(schema.attestationInheritances.cacheId, cache.id))
					.run();
				context.db
					.delete(schema.narInfos)
					.where(eq(schema.narInfos.cacheId, cache.id))
					.run();
				context.db
					.insert(schema.narInfos)
					.values({
						cacheId: cache.id,
						storePathHash: metadata.storePathHash,
						storePath: metadata.storePath,
						narHash: nar.narHash,
						narSize: nar.narSize,
						referencesJson: '[]',
						createdAt: isoTimestamp(new Date())
					})
					.run();
				await attestationsFor(context).queueInheritance(
					cache,
					metadata.storePathHash,
					narInfoGenerationSchema.parse(0),
					nar.narHash
				);
			});
			const cursors: { result: string; digest: Sha256HexDigest | undefined }[] =
				[];
			const budgets: { subrequests: number; rows: number }[] = [];
			const pageSubrequests =
				inheritanceLookupSubrequests + inheritanceListSubrequests;
			const pagesPerDispatch = Math.floor(
				(workersInvocationAllowances.free.subrequests -
					subrequestSafetyReserve) /
					pageSubrequests
			);
			const readPage = async (
				instance: CupboardServer,
				state: DurableObjectState
			) => {
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: binding
				});
				budgets.push({
					subrequests: subrequestsAvailable(),
					rows: rowsRemaining()
				});
				const cache = resolvedCache(context, destination);
				const result = await attestationsFor(context).inheritFromTenant(
					rootLogger(),
					{
						cache,
						storePathHash: metadata.storePathHash,
						generation: narInfoGenerationSchema.parse(0),
						narHash: nar.narHash
					}
				);
				const queue = context.db
					.select()
					.from(schema.attestationInheritances)
					.where(
						and(
							eq(schema.attestationInheritances.cacheId, cache.id),
							eq(
								schema.attestationInheritances.storePathHash,
								metadata.storePathHash
							)
						)
					)
					.get();
				if (queue === undefined) {
					throw new Error(
						'The scale fixture must preserve its queued traversal.'
					);
				}
				return {
					result,
					digest: queue.sourceDigest ?? undefined
				};
			};
			const pageGroups = chunk(Array.from({ length: 391 }), pagesPerDispatch);
			for (const passes of pageGroups) {
				await runInDurableObject(
					fixtureWorkerServer(),
					async (instance, state) => {
						for (const _pass of passes) {
							const cursor = await withRowBudget(() =>
								withSubrequestSlice(() => readPage(instance, state), {
									subrequests: pageSubrequests,
									reserve: 0
								})
							);
							cursors.push(cursor);
						}
					}
				);
			}
			expect({
				cursors,
				budgets,
				bounded: reads.every((read) => read <= 1000)
			}).toStrictEqual({
				cursors: [
					...Array.from({ length: 390 }, (_, index) => ({
						result: 'budget-exhausted-after-progress',
						digest: sha256HexDigestSchema.parse(
							((index + 1) * 64).toString(16).padStart(64, '0')
						)
					})),
					{ result: 'complete', digest: undefined }
				],
				budgets: Array.from({ length: 391 }, () => ({
					subrequests:
						inheritanceLookupSubrequests + inheritanceListSubrequests,
					rows: 25_000
				})),
				bounded: true
			});
		}
	);

	it('continues inheriting after a path exceeds one pass of bundles', async () => {
		const { destination, metadata, digest } = await reusedPathWithSourceBundle(
			'many-inherited-bundles'
		);
		const digests = Array.from({ length: 65 }, (_, index) =>
			sha256HexDigestSchema.parse((index + 1).toString(16).padStart(64, '0'))
		);
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		for (const page of chunk(digests, 25)) {
			await database.insert(d1Schema.casObject).values(
				page.map((digest) => ({
					digest,
					size: 1,
					storedAt: isoTimestamp(new Date())
				}))
			);
		}
		for (const page of chunk(digests, 10)) {
			await database.insert(d1Schema.attestationReference).values(
				page.map((digest) => ({
					tenant: fixtureTenant,
					cacheKind: 'default' as const,
					storePathHash: metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(0),
					predicateType: predicateTypeSchema.parse(predicateType),
					digest
				}))
			);
		}
		await Promise.all(
			digests.map((digest) =>
				env.BLOBS.put(casObjectKey(digest, 1), new Uint8Array([1]))
			)
		);

		const first = await drainInheritance();
		const firstQueue = await queuedInheritances();
		await makeQueuedInheritancesDue();
		const second = await drainInheritance();
		const secondQueue = await queuedInheritances();
		const inherited = await database
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.cacheKind, 'named'),
					eq(d1Schema.attestationReference.cacheName, destination.name),
					eq(
						d1Schema.attestationReference.storePathHash,
						metadata.storePathHash
					)
				)
			)
			.orderBy(d1Schema.attestationReference.digest);
		expect({
			first,
			firstQueue,
			second,
			secondQueue,
			inherited: inherited.map((row) => row.digest)
		}).toStrictEqual({
			first: 'progressed',
			firstQueue: [{ storePathHash: metadata.storePathHash, attempts: 0 }],
			second: 'progressed',
			secondQueue: [],
			inherited: [...digests, digest].toSorted(byCodeUnit)
		});
	});

	it.each([64, 128])(
		'inherits a valid source after %s missing sources across repeated drains',
		async (missingCount) => {
			const { destination, metadata, digest } =
				await reusedPathWithSourceBundle('missing-source-pages');
			const missing = Array.from({ length: missingCount }, (_, index) =>
				sha256HexDigestSchema.parse((index + 1).toString(16).padStart(64, '0'))
			);
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			for (const page of chunk(missing, 25)) {
				await database.insert(d1Schema.casObject).values(
					page.map((digest) => ({
						digest,
						size: 1,
						storedAt: isoTimestamp(new Date())
					}))
				);
			}
			for (const page of chunk(missing, 10)) {
				await database.insert(d1Schema.attestationReference).values(
					page.map((digest) => ({
						tenant: fixtureTenant,
						cacheKind: 'default' as const,
						storePathHash: metadata.storePathHash,
						generation: narInfoGenerationSchema.parse(0),
						predicateType: predicateTypeSchema.parse(predicateType),
						digest
					}))
				);
			}
			const heads = vi.spyOn(env.BLOBS, 'head');
			const pages = [];
			for (let page = 0; page <= missingCount / 64; page += 1) {
				pages.push({
					progress: await drainInheritance(),
					queued: await queuedInheritances()
				});
				await restartTestServers();
				const resumed = await fixtureWorkerServer().fetch(
					new Request(`${internalOrigin}/pubkey`)
				);
				await resumed.arrayBuffer();
				await makeQueuedInheritancesDue();
			}
			const missingHeads = heads.mock.calls
				.map(([key]) => key)
				.filter((key) =>
					missing.some((digest) => key === casObjectKey(digest))
				);
			const list = await readFetch(
				`/cache/${destination.name}/attestations/${metadata.storePathHash}`
			);
			expect({
				pages,
				missingHeads,
				listStatus: list.status,
				listed: list.ok
					? attestationListSchema
							.parse(await list.json())
							.attestations.map((attestation) => attestation.digest)
					: []
			}).toStrictEqual({
				pages: [
					...Array.from({ length: missingCount / 64 }, () => ({
						progress: 'progressed',
						queued: [{ storePathHash: metadata.storePathHash, attempts: 0 }]
					})),
					{ progress: 'progressed', queued: [] }
				],
				missingHeads: missing.map((digest) => casObjectKey(digest)),
				listStatus: StatusCodes.OK,
				listed: [digest]
			});
		}
	);

	it('searches the path index for inheritance sources', async () => {
		const destination = namedCache('indexed-sources');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('indexed-sources');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);

		const statements: { query: string; values: unknown[] }[] = [];
		const originalPrepare = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				const statement = originalPrepare(query);

				if (!query.includes('inheritance_source_reference')) {
					return statement;
				}

				const originalBind = statement.bind.bind(statement);
				statement.bind = (...values: unknown[]) => {
					statements.push({ query, values });

					return originalBind(...values);
				};

				return statement;
			});

		try {
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const service = attestationsFor(instance.context);
				const cache = resolvedCache(instance.context, destination);

				await service.inheritFromTenant(rootLogger(), {
					cache,
					storePathHash: metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(0),
					narHash: metadata.narHash
				});
			});
		} finally {
			prepare.mockRestore();
		}

		const plans = await Promise.all(
			statements.map(async ({ query, values }) => {
				const explained = await env.CUPBOARD_DB.prepare(
					`EXPLAIN QUERY PLAN ${query}`
				)
					.bind(...values)
					.all();
				const details = z
					.array(z.object({ detail: z.string() }))
					.parse(explained.results)
					.map((row) => row.detail);

				return {
					searchesPathIndex: details.some((detail) =>
						detail.startsWith(
							'SEARCH attestation_ref_storage USING INDEX attestation_ref_default_identity_idx'
						)
					),
					scans: details.filter((detail) =>
						detail.startsWith('SCAN attestation_ref_storage')
					).length
				};
			})
		);

		expect(plans).toStrictEqual([{ searchesPathIndex: true, scans: 0 }]);
	});

	it('counts only the sources that the destination lacks against its subrequests', async () => {
		const { token, metadata, nar } = await committedPathBundle();
		const destination = namedCache('partly-inherited');
		await putWorkerTestCache(token, destination);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		const digests = [1, 2, 3].map((index) =>
			sha256HexDigestSchema.parse(index.toString(16).padStart(64, '0'))
		);
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const [inherited] = digests;

		if (inherited === undefined) {
			throw new Error('the test needs an inherited digest');
		}

		await database.insert(d1Schema.casObject).values(
			digests.map((digest) => ({
				digest,
				size: 1,
				storedAt: isoTimestamp(new Date())
			}))
		);
		await database.insert(d1Schema.attestationReference).values([
			...digests.map((digest) => ({
				tenant: fixtureTenant,
				cacheKind: 'default' as const,
				storePathHash: metadata.storePathHash,
				generation: narInfoGenerationSchema.parse(0),
				predicateType: predicateTypeSchema.parse(predicateType),
				digest
			})),
			{
				tenant: fixtureTenant,
				cacheKind: 'named' as const,
				cacheName: destination.name,
				storePathHash: metadata.storePathHash,
				generation: narInfoGenerationSchema.parse(0),
				predicateType: predicateTypeSchema.parse(predicateType),
				digest: inherited
			}
		]);
		const heads = vi.spyOn(env.BLOBS, 'head');

		// The slice pays for the lookup, the list and two bundles: fewer bundles
		// than the source has, but as many as the destination lacks.
		const subrequests =
			inheritanceLookupSubrequests +
			inheritanceListSubrequests +
			2 * inheritedBundleSubrequests;
		const outcome = await (async () => {
			try {
				const result = await runInDurableObject(
					fixtureWorkerServer(),
					(instance) =>
						withSubrequestSlice(
							() =>
								attestationsFor(instance.context).inheritFromTenant(
									rootLogger(),
									{
										cache: resolvedCache(instance.context, destination),
										storePathHash: metadata.storePathHash,
										generation: narInfoGenerationSchema.parse(0),
										narHash: metadata.narHash
									}
								),
							{ subrequests, reserve: 0 }
						)
				);

				return { result, heads: heads.mock.calls.length };
			} finally {
				heads.mockRestore();
			}
		})();

		expect(outcome).toStrictEqual({ result: 'complete', heads: 2 });
	});

	it('skips R2 checks for bundles that the destination already references', async () => {
		const destination = namedCache('already-inherited');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('already-inherited');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		await attachBundle(
			token,
			metadata.storePathHash,
			sigstoreBundleBytes(narDigestHex(nar.narHash))
		);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		await drainInheritance();
		const heads = vi.spyOn(env.BLOBS, 'head');

		try {
			const result = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance) => {
					const service = attestationsFor(instance.context);
					const cache = resolvedCache(instance.context, destination);
					return service.inheritFromTenant(rootLogger(), {
						cache,
						storePathHash: metadata.storePathHash,
						generation: narInfoGenerationSchema.parse(0),
						narHash: metadata.narHash
					});
				}
			);

			expect({ result, heads: heads.mock.calls.length }).toStrictEqual({
				result: 'complete',
				heads: 0
			});
		} finally {
			heads.mockRestore();
		}
	});

	it.each([
		{ pauseAfter: 'lookup', revocation: 'private' },
		{ pauseAfter: 'head', revocation: 'private' },
		{ pauseAfter: 'lookup', revocation: 'recreation' }
	] as const)(
		'does not inherit a bundle after source $revocation following $pauseAfter',
		async ({ pauseAfter, revocation }) => {
			await recordTransition('cache-identity', 'complete');
			const source = namedCache('revoked-source');
			const destination = namedCache('revoked-destination');
			const token = await initialiseViaWorker();
			await putWorkerTestCache(token, source);
			await putWorkerTestCache(token, destination);
			const nar = await verifiableNar('revoked-inheritance-source');
			const metadata = uploadMetadata({
				storePathHash: uniqueStorePathHash(),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			await pushPathThroughTenant(fixtureTenant, token, metadata, nar, source);
			const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
			const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
			await attachBundle(token, metadata.storePathHash, bundle, source);
			await pushPathThroughTenant(
				fixtureTenant,
				token,
				metadata,
				nar,
				destination
			);
			const revokeSource = async (): Promise<void> => {
				if (revocation === 'private') {
					await putWorkerTestCache(token, source, 'private');
					return;
				}

				const removed = await authorisedWorkerFetch(
					`/caches/${source.name}?force=true`,
					token,
					{ method: 'DELETE' }
				);
				expect(removed.status).toBe(StatusCodes.OK);
				await putWorkerTestCache(token, source);
			};

			if (pauseAfter === 'lookup') {
				await revokeSource();
			} else {
				const head = env.BLOBS.head.bind(env.BLOBS);
				vi.spyOn(env.BLOBS, 'head').mockImplementationOnce(async (key) => {
					const object = await head(key);
					await revokeSource();

					return object;
				});
			}

			const result = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					attestationsFor(instance.context).inheritFromTenant(rootLogger(), {
						cache: resolvedCache(instance.context, destination),
						storePathHash: metadata.storePathHash,
						generation: narInfoGenerationSchema.parse(0),
						narHash: metadata.narHash
					})
			);
			const sourceRead = await readFetch(
				cacheScopedPath(source, `/attestation-bundles/${digest}`)
			);
			const destinationRead = await readFetch(
				cacheScopedPath(destination, `/attestation-bundles/${digest}`)
			);
			const destinationList = await readFetch(
				cacheScopedPath(destination, `/attestations/${metadata.storePathHash}`)
			);

			expect({
				result,
				sourceStatus: sourceRead.status,
				destinationStatus: destinationRead.status,
				listStatus: destinationList.status
			}).toStrictEqual({
				result: 'complete',
				sourceStatus:
					revocation === 'private'
						? StatusCodes.UNAUTHORIZED
						: StatusCodes.NOT_FOUND,
				destinationStatus: StatusCodes.NOT_FOUND,
				listStatus: StatusCodes.NOT_FOUND
			});
		}
	);

	it('inherits the source cache bundle after the commit when another cache reuses the path', async () => {
		const destination = namedCache('reused');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('attestation-reused-path');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		await attachBundle(token, metadata.storePathHash, bundle);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		const listBeforeDrain = await readFetch(
			`/cache/reused/attestations/${metadata.storePathHash}`
		);

		const drain = await drainInheritance();
		const list = await readFetch(
			`/cache/reused/attestations/${metadata.storePathHash}`
		);
		const bundleRead = await readFetch(
			`/cache/reused/attestation-bundles/${digest}`
		);

		expect({
			listStatusBeforeDrain: listBeforeDrain.status,
			drain,
			queued: await queuedInheritances(),
			listStatus: list.status,
			list: attestationListSchema.parse(await list.json()),
			bundleStatus: bundleRead.status
		}).toStrictEqual({
			listStatusBeforeDrain: StatusCodes.NOT_FOUND,
			drain: 'progressed',
			queued: [],
			listStatus: StatusCodes.OK,
			list: {
				attestations: [{ digest, predicateType, size: bundle.byteLength }]
			},
			bundleStatus: StatusCodes.OK
		});
	});

	it('inherits for the committed path, not for the identity in a batch entry', async () => {
		const destination = namedCache('batch-identity');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const sourceNar = await verifiableNar('batch-identity-source');
		const targetNar = await verifiableNar('batch-identity-target');
		const source = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: sourceNar.narHash,
			narSize: sourceNar.narSize,
			fileHash: sourceNar.fileHash,
			fileSize: sourceNar.narBytes.byteLength
		});
		const target = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: targetNar.narHash,
			narSize: targetNar.narSize,
			fileHash: targetNar.fileHash,
			fileSize: targetNar.narBytes.byteLength
		});
		const targetBundle = sigstoreBundleBytes(narDigestHex(targetNar.narHash));
		const targetDigest = sha256HexDigestSchema.parse(
			await sha256HexBytes(targetBundle)
		);
		await pushPathThroughTenant(fixtureTenant, token, source, sourceNar);
		await attachBundle(
			token,
			source.storePathHash,
			sigstoreBundleBytes(narDigestHex(sourceNar.narHash))
		);
		await pushPathThroughTenant(fixtureTenant, token, target, targetNar);
		await attachBundle(token, target.storePathHash, targetBundle);
		await drainInheritance();
		const negotiated = await tenantFetch(
			fixtureTenant,
			cacheScopedPath(destination, '/uploads'),
			token,
			{
				body: JSON.stringify({
					pushId: await testPushIdFor(fixtureTenant),
					paths: [uploadPathNegotiation(target)]
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			}
		);
		const [decision] = z
			.tuple([uploadDecisionSchema])
			.parse(
				uploadNegotiateResponseSchema.parse(await negotiated.json()).uploads
			);

		if (decision.action !== 'commit') {
			throw new Error(`expected a reuse commit, got ${decision.action}`);
		}

		const session = commitSessionFromResponse(
			await tenantFetch(
				fixtureTenant,
				cacheScopedPath(destination, '/commit'),
				token,
				{ headers: { upgrade: 'websocket' } }
			)
		);
		// A batch entry is client-supplied. This one specifies the source path and
		// NAR, not those of its pending upload.
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: decision.uploadId,
					storePathHash: source.storePathHash,
					narHash: source.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();
		const queued = await queuedInheritances();
		await drainInheritance();
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${target.storePathHash}`
		);

		expect({
			frame: frame.ev,
			queued,
			listStatus: list.status,
			listed: list.ok
				? attestationListSchema
						.parse(await list.json())
						.attestations.map((attestation) => attestation.digest)
				: []
		}).toStrictEqual({
			frame: 'settled',
			queued: [{ storePathHash: target.storePathHash, attempts: 0 }],
			listStatus: StatusCodes.OK,
			listed: [targetDigest]
		});
	});

	it.each(['suspended', 'offboarding'] as const)(
		'does not attempt inheritance while the tenant is %s',
		async (status) => {
			const { metadata } = await reusedPathWithSourceBundle(`paused-${status}`);
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const tenant = eq(d1Schema.tenant.id, fixtureTenant);
			const work = vi.spyOn(AttestationsService.prototype, 'inheritFromTenant');
			try {
				await database.update(d1Schema.tenant).set({ status }).where(tenant);
				expect({
					drained: await drainInheritance(),
					workCalls: work.mock.calls.length,
					queued: await queuedInheritances()
				}).toStrictEqual({
					drained: 'progressed',
					workCalls: 0,
					queued: [{ storePathHash: metadata.storePathHash, attempts: 0 }]
				});
			} finally {
				work.mockRestore();
				await database
					.update(d1Schema.tenant)
					.set({ status: 'active' })
					.where(tenant);
				await drainInheritance();
			}
		}
	);

	it('does not duplicate an inheritance attempt during an overlapping claimed attempt', async () => {
		const { metadata } = await reusedPathWithSourceBundle('overlapping-retry');
		const entered = Promise.withResolvers<undefined>();
		const resume = Promise.withResolvers<undefined>();
		const work = vi
			.spyOn(AttestationsService.prototype, 'inheritFromTenant')
			.mockImplementationOnce(async () => {
				entered.resolve(undefined);
				await resume.promise;
				throw new Error('provider request failed');
			});
		try {
			const results = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance) => {
					const service = attestationsFor(instance.context);
					const first = service.drainInheritanceQueue(rootLogger());
					await entered.promise;
					const second = await service.drainInheritanceQueue(rootLogger());
					resume.resolve(undefined);
					return { first: await first, second };
				}
			);
			expect({
				results,
				workCalls: work.mock.calls.length,
				queued: await queuedInheritances()
			}).toStrictEqual({
				results: {
					first: { progress: 'progressed', dequeued: [] },
					second: { progress: 'stalled', dequeued: [] }
				},
				workCalls: 1,
				queued: [{ storePathHash: metadata.storePathHash, attempts: 1 }]
			});
		} finally {
			resume.resolve(undefined);
			work.mockRestore();
			await makeQueuedInheritancesDue();
			await drainInheritance();
		}
	});

	it.each(['source lookup', 'list write'] as const)(
		'does not overwrite a replacement claim while %s awaits D1',
		async (boundary) => {
			const { destination, metadata } = await reusedPathWithSourceBundle(
				`claim-owner-${boundary.replaceAll(' ', '-')}`
			);
			const result = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance, state) => {
					const table = schema.attestationInheritances;
					const cache = resolvedCache(instance.context, destination);
					const filter = and(
						eq(table.cacheId, cache.id),
						eq(table.storePathHash, metadata.storePathHash)
					);
					instance.context.db
						.update(table)
						.set({ claimOwner: 'previous-owner' })
						.where(filter)
						.run();
					let replacement: typeof table.$inferSelect | undefined;
					const queryPrefix =
						boundary === 'source lookup'
							? 'select "generation"'
							: 'select "attestation_ref_storage"."digest"';
					const wrap = (
						statement: D1PreparedStatement,
						query: string
					): D1PreparedStatement =>
						new Proxy(statement, {
							get(source, field) {
								if (field === 'bind') {
									return (...values: unknown[]) =>
										wrap(source.bind(...values), query);
								}
								if (field === 'raw' && query.startsWith(queryPrefix)) {
									return async () => {
										instance.context.db
											.update(table)
											.set({ claimOwner: 'replacement-owner' })
											.where(filter)
											.run();
										replacement = instance.context.db
											.select()
											.from(table)
											.where(filter)
											.get();
										return source.raw();
									};
								}
								const value: unknown = Reflect.get(source, field, source);
								return typeof value === 'function'
									? (...arguments_: unknown[]): unknown =>
											Reflect.apply(value, source, arguments_)
									: value;
							}
						});
					const binding = new Proxy(env.CUPBOARD_DB, {
						get(target, field) {
							if (field === 'prepare') {
								return (query: string) => wrap(target.prepare(query), query);
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
					const inherited = await attestationsFor(context).inheritFromTenant(
						rootLogger(),
						{
							cache,
							storePathHash: metadata.storePathHash,
							generation: narInfoGenerationSchema.parse(0),
							narHash: metadata.narHash,
							claimOwner: 'previous-owner'
						}
					);
					const queue = instance.context.db
						.select()
						.from(table)
						.where(filter)
						.get();
					instance.context.db
						.update(table)
						.set({ claimOwner: sql`null` })
						.where(filter)
						.run();
					return {
						replaced: replacement !== undefined,
						inherited,
						queue,
						replacement
					};
				}
			);
			expect(result).toStrictEqual({
				replaced: true,
				inherited: 'superseded',
				queue: result.replacement,
				replacement: result.replacement
			});
			await drainInheritance();
		}
	);

	it.each(['attempt-limit', 'eligible-age-limit'] as const)(
		'exhausts inheritance after %s with safe seven-day diagnostics and no client reset',
		async (bound) => {
			const { destination, metadata } = await reusedPathWithSourceBundle(
				`bounded-${bound}`
			);
			const now = new Date();
			vi.useFakeTimers();
			vi.setSystemTime(now);
			const row = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) => {
					const cacheId =
						instance.context.cacheRepository.require(destination).id;
					const filter = and(
						eq(schema.attestationInheritances.cacheId, cacheId),
						eq(
							schema.attestationInheritances.storePathHash,
							metadata.storePathHash
						)
					);
					return instance.context.db
						.update(schema.attestationInheritances)
						.set({
							attempts: bound === 'attempt-limit' ? 11 : 0,
							retryStartedActiveMs: 0
						})
						.where(filter)
						.returning()
						.all()
						.at(0);
				}
			);

			if (row === undefined) {
				throw new Error('The fixture needs its queued inheritance row.');
			}
			await drizzleD1(env.CUPBOARD_DB)
				.update(d1Schema.tenant)
				.set({
					retryActiveElapsedMs: bound === 'eligible-age-limit' ? 86_400_000 : 0,
					retryActiveSinceMs: sql`null`
				})
				.run();
			const failure = vi
				.spyOn(AttestationsService.prototype, 'inheritFromTenant')
				.mockRejectedValue(
					new Error('https://provider.invalid/private?token=sensitive')
				);
			const capture = startCapture();
			try {
				await drainInheritance();
				await runInDurableObject(fixtureWorkerServer(), (instance) =>
					attestationsFor(instance.context).queueInheritance(
						instance.context.cacheRepository.require(destination),
						row.storePathHash,
						row.generation,
						row.narHash
					)
				);
			} finally {
				capture.stop();
			}
			const diagnostics = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					instance.context.db
						.select()
						.from(schema.attestationInheritanceFailures)
						.where(
							and(
								eq(schema.attestationInheritanceFailures.cacheId, row.cacheId),
								eq(
									schema.attestationInheritanceFailures.storePathHash,
									row.storePathHash
								)
							)
						)
						.all()
			);
			const queued = await queuedInheritances();
			const expiresAt = isoTimestamp(
				new Date(now.getTime() + 7 * 24 * 60 * 60_000)
			);
			expect({
				queued: queued.filter(
					(queued) => queued.storePathHash === metadata.storePathHash
				),
				diagnostics,
				attempts: failure.mock.calls.length,
				warnings: capture.logs
					.filter((entry) => entry.level === 'warning')
					.map((entry) => ({
						message: entry.message,
						properties: entry.properties
					}))
			}).toStrictEqual({
				queued: [],
				diagnostics: [
					{
						cacheId: row.cacheId,
						storePathHash: row.storePathHash,
						generation: row.generation,
						category: 'inheritance-failed',
						exhaustion: bound,
						failures: bound === 'attempt-limit' ? 12 : 0,
						exhaustedAt: isoTimestamp(now),
						expiresAt
					}
				],
				attempts: bound === 'attempt-limit' ? 1 : 0,
				warnings: [
					{
						message: 'attestation inheritance exhausted',
						properties: {
							cacheId: row.cacheId,
							storePathHash: row.storePathHash,
							generation: row.generation,
							category: 'inheritance-failed',
							exhaustion: bound,
							failures: bound === 'attempt-limit' ? 12 : 0
						}
					}
				]
			});
			vi.setSystemTime(new Date(now.getTime() + 7 * 24 * 60 * 60_000));
			await drainInheritance();
			await runInDurableObject(fixtureWorkerServer(), (instance) =>
				attestationsFor(instance.context).queueInheritance(
					instance.context.cacheRepository.require(destination),
					row.storePathHash,
					row.generation,
					row.narHash
				)
			);
			const expired = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) => {
					const filter = and(
						eq(schema.attestationInheritanceFailures.cacheId, row.cacheId),
						eq(
							schema.attestationInheritanceFailures.storePathHash,
							row.storePathHash
						)
					);
					return instance.context.db
						.select()
						.from(schema.attestationInheritanceFailures)
						.where(filter)
						.all();
				}
			);
			const afterExpiry = await queuedInheritances();
			expect({
				diagnostics: expired,
				queued: afterExpiry.filter(
					(queued) => queued.storePathHash === metadata.storePathHash
				),
				attempts: failure.mock.calls.length
			}).toStrictEqual({
				diagnostics: [],
				queued: [],
				attempts: bound === 'attempt-limit' ? 1 : 0
			});
		}
	);

	it('retries inheritance after a failed attempt and after running out of subrequests', async () => {
		const destination = namedCache('reuse-after-attestation-error');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('reuse-attestation-error');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		await attachBundle(
			token,
			metadata.storePathHash,
			sigstoreBundleBytes(narDigestHex(nar.narHash))
		);
		// Drain the source cache's own queued path, so that only the destination
		// remains queued.
		await drainInheritance();
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		const narInfo = await readFetch(
			`/cache/${destination.name}/${metadata.storePathHash}.narinfo`
		);
		const inheritance = vi
			.spyOn(AttestationsService.prototype, 'inheritFromTenant')
			.mockRejectedValueOnce(new Error('attestation lookup failed'));
		const listStatus = async () => {
			const response = await readFetch(
				`/cache/${destination.name}/attestations/${metadata.storePathHash}`
			);

			return response.status;
		};

		try {
			const failed = await drainInheritance();
			const afterFailure = await queuedInheritances();
			await makeQueuedInheritancesDue();
			// Leave the drain enough subrequests for the source lookup and the
			// list write, but not for the bundle.
			const exhausted = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					withSubrequestSlice(
						() =>
							attestationsFor(instance.context).drainInheritanceQueue(
								rootLogger()
							),
						{
							subrequests:
								subrequestSliceReserve +
								inheritanceLookupSubrequests +
								inheritanceListSubrequests,
							reserve: subrequestSliceReserve
						}
					)
			);
			const afterExhaustion = await queuedInheritances();
			const listAfterExhaustion = await listStatus();
			const completed = await drainInheritance();

			expect({
				narInfoStatus: narInfo.status,
				failed,
				afterFailure,
				exhausted,
				afterExhaustion,
				listAfterExhaustion,
				completed,
				queued: await queuedInheritances(),
				listStatus: await listStatus()
			}).toStrictEqual({
				narInfoStatus: StatusCodes.OK,
				failed: 'progressed',
				afterFailure: [{ storePathHash: metadata.storePathHash, attempts: 1 }],
				exhausted: { progress: 'progressed', dequeued: [] },
				afterExhaustion: [
					{ storePathHash: metadata.storePathHash, attempts: 1 }
				],
				listAfterExhaustion: StatusCodes.NOT_FOUND,
				completed: 'progressed',
				queued: [],
				listStatus: StatusCodes.OK
			});
		} finally {
			inheritance.mockRestore();
		}
	});

	it('writes the list when an interrupted attempt left references without it', async () => {
		const { destination, metadata, digest } = await reusedPathWithSourceBundle(
			'interrupted-inheritance'
		);

		// Reproduce an attempt that the runtime stopped after it referenced the
		// bundle and before it wrote the list.
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			await new AttestationCasService(
				instance.context
			).reserveReferenceAndCharge(
				{
					cache: destination,
					storePathHash: metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(0),
					predicateType: predicateTypeSchema.parse(predicateType),
					digest
				},
				1
			);
		});
		const listBeforeDrain = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);
		await drainInheritance();
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			listStatusBeforeDrain: listBeforeDrain.status,
			queued: await queuedInheritances(),
			listed: list.ok
				? attestationListSchema
						.parse(await list.json())
						.attestations.map((attestation) => attestation.digest)
				: []
		}).toStrictEqual({
			listStatusBeforeDrain: StatusCodes.NOT_FOUND,
			queued: [],
			listed: [digest]
		});
	});

	it('writes the list on a retry after the source of an inherited bundle is gone', async () => {
		const { destination, metadata, digest } = await reusedPathWithSourceBundle(
			'list-without-source'
		);
		const listWrite = vi
			.spyOn(AttestationsService.prototype, 'materialiseList')
			.mockRejectedValueOnce(new Error('attestation list write failed'));

		const failed = await drainInheritance();
		listWrite.mockRestore();
		const queuedAfterFailure = await queuedInheritances();
		const listAfterFailure = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);
		// The source path's references go before the retry.
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.delete(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, fixtureTenant),
					eq(d1Schema.attestationReference.cacheKind, 'default'),
					eq(
						d1Schema.attestationReference.storePathHash,
						metadata.storePathHash
					)
				)
			);
		await makeQueuedInheritancesDue();
		const retried = await drainInheritance();
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			failed,
			queuedAfterFailure,
			listStatusAfterFailure: listAfterFailure.status,
			retried,
			queued: await queuedInheritances(),
			listed: list.ok
				? attestationListSchema
						.parse(await list.json())
						.attestations.map((attestation) => attestation.digest)
				: []
		}).toStrictEqual({
			failed: 'progressed',
			queuedAfterFailure: [
				{ storePathHash: metadata.storePathHash, attempts: 1 }
			],
			listStatusAfterFailure: StatusCodes.NOT_FOUND,
			retried: 'progressed',
			queued: [],
			listed: [digest]
		});
	});

	it('keeps the alarm armed for a retry when an earlier alarm runs, and retries through the alarm', async () => {
		const { destination, metadata } =
			await reusedPathWithSourceBundle('retry-alarm');
		const nextInheritanceAt = vi.spyOn(
			AttestationsService.prototype,
			'nextInheritanceAt'
		);
		const failing = vi
			.spyOn(AttestationsService.prototype, 'inheritFromTenant')
			.mockRejectedValueOnce(new Error('attestation lookup failed'));

		const retry = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance, state) => {
				await attestationsFor(instance.context).drainInheritanceQueue(
					rootLogger()
				);
				failing.mockRestore();
				// The commit armed an alarm. Until the failed attempt is recorded, its
				// delivery must not run the inheritance pass.
				nextInheritanceAt.mockRestore();
				const [queued] = instance.context.db
					.select({ notBefore: schema.attestationInheritances.notBefore })
					.from(schema.attestationInheritances)
					.all();
				// An earlier alarm, such as one that a commit arms, runs first.
				await state.storage.setAlarm(Date.now());
				await instance.alarm();

				return {
					retryAt:
						queued === undefined ? undefined : Date.parse(queued.notBefore),
					armedAt: await state.storage.getAlarm()
				};
			}
		);
		await makeQueuedInheritancesDue();
		await runInDurableObject(fixtureWorkerServer(), async (instance, state) => {
			// Start the rotation at the inheritance pass.
			await state.storage.put(maintenancePassCursorKey, 'garbage-collection');
			await instance.alarm();
		});
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			isArmedForRetry:
				retry.retryAt !== undefined &&
				retry.armedAt !== null &&
				retry.armedAt <= retry.retryAt,
			queued: await queuedInheritances(),
			listStatus: list.status
		}).toStrictEqual({
			isArmedForRetry: true,
			queued: [],
			listStatus: StatusCodes.OK
		});
	});

	it('keeps a path queued after repeated transient failures', async () => {
		const { destination, metadata } = await reusedPathWithSourceBundle(
			'abandoned-inheritance'
		);
		const failing = vi
			.spyOn(AttestationsService.prototype, 'inheritFromTenant')
			.mockRejectedValue(new Error('attestation lookup failed'));
		const attempts: number[][] = [];
		const calls = await (async () => {
			try {
				for (let attempt = 1; attempt <= 6; attempt += 1) {
					await drainInheritance();
					const queued = await queuedInheritances();
					attempts.push(queued.map((row) => row.attempts));
					await makeQueuedInheritancesDue();
				}

				return failing.mock.calls.length;
			} finally {
				failing.mockRestore();
			}
		})();

		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			calls,
			attempts,
			listStatus: list.status
		}).toStrictEqual({
			calls: 6,
			attempts: [[1], [2], [3], [4], [5], [6]],
			listStatus: StatusCodes.NOT_FOUND
		});
	});

	it('inherits a public source bundle when its path is collected before the drain', async () => {
		const { destination, metadata, digest } = await reusedPathWithSourceBundle(
			'source-collected-before-inheritance'
		);
		const first = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const cache = resolvedCache(instance.context);
				instance.context.db
					.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, metadata.storePathHash)
						)
					)
					.run();
				instance.context.db
					.insert(schema.narInfoDeletions)
					.values({
						cacheId: cache.id,
						storePathHash: metadata.storePathHash,
						generation: narInfoGenerationSchema.parse(0),
						narHash: metadata.narHash,
						createdAt: isoTimestamp(new Date())
					})
					.run();
				const narInfoObjects = new NarInfoObjectsService(instance.context);
				const attestationCas = new AttestationCasService(instance.context);
				const attestations = attestationsFor(instance.context);
				const deletionQueue = new DeletionQueueService(
					instance.context,
					attestationCas,
					attestations,
					narInfoObjects
				);
				return instance.context.criticalSection(() =>
					deletionQueue.flushQueuedNarInfoDeletions()
				);
			}
		);
		await drainInheritance();
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const references = await database
			.select({
				cacheKind: d1Schema.attestationReference.cacheKind,
				cacheName: d1Schema.attestationReference.cacheName,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.digest, digest));
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);
		expect({
			first,
			references: references.map((row) => ({
				...row,
				cacheName: row.cacheName ?? 'default'
			})),
			listStatus: list.status
		}).toStrictEqual({
			first: 0,
			references: [
				{ cacheKind: 'default', cacheName: 'default', digest },
				{ cacheKind: 'named', cacheName: destination.name, digest }
			],
			listStatus: StatusCodes.OK
		});
		const retired = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const narInfoObjects = new NarInfoObjectsService(instance.context);
				const attestationCas = new AttestationCasService(instance.context);
				const deletionQueue = new DeletionQueueService(
					instance.context,
					attestationCas,
					attestationsFor(instance.context),
					narInfoObjects
				);
				return instance.context.criticalSection(() =>
					deletionQueue.flushQueuedNarInfoDeletions()
				);
			}
		);
		const remaining = await database
			.select({
				cacheKind: d1Schema.attestationReference.cacheKind,
				cacheName: d1Schema.attestationReference.cacheName,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.digest, digest));
		const destinationList = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);
		expect({
			retired,
			remaining,
			destinationListStatus: destinationList.status
		}).toStrictEqual({
			retired: 1,
			remaining: [{ cacheKind: 'named', cacheName: destination.name, digest }],
			destinationListStatus: StatusCodes.OK
		});
	});

	it.each(['pending', 'committed'] as const)(
		'inherits from an explicitly deleted public source for a $0 destination',
		async (phase) => {
			let deleted:
				| Awaited<ReturnType<DeletionQueueService['deleteStorePath']>>
				| undefined;
			const { token, destination, metadata, digest } =
				await reusedPathWithSourceBundle(
					'source-explicitly-deleted',
					'private',
					phase === 'pending'
						? async (storePathHash) => {
								deleted = await deleteFixtureSource(storePathHash);
							}
						: undefined
				);
			if (phase === 'committed') {
				deleted = await deleteFixtureSource(metadata.storePathHash);
			}

			const sourcePaths = [
				`/${metadata.storePathHash}.narinfo`,
				`/${await currentNarObjectKey(metadata.narHash)}`,
				`/attestations/${metadata.storePathHash}`,
				`/attestation-bundles/${digest}`
			];
			for (const method of ['GET', 'HEAD']) {
				for (const authentication of ['anonymous', 'authenticated']) {
					const headers: HeadersInit =
						authentication === 'authenticated'
							? { authorization: `Bearer ${token}` }
							: {};
					const responses = await Promise.all(
						sourcePaths.map((path) => readFetch(path, { method, headers }))
					);
					expect(responses.map((response) => response.status)).toStrictEqual([
						404, 404, 404, 404
					]);
				}
			}

			const later = namedCache('accepted-after-deletion');
			await putWorkerTestCache(token, later);
			await pushPathThroughTenant(
				fixtureTenant,
				token,
				metadata,
				await verifiableNar('source-explicitly-deleted'),
				later
			);
			await drainInheritance();
			await drainInheritance();
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const references = await database
				.select({
					cacheKind: d1Schema.attestationReference.cacheKind,
					digest: d1Schema.attestationReference.digest
				})
				.from(d1Schema.attestationReference)
				.where(eq(d1Schema.attestationReference.digest, digest));
			const list = await readFetch(
				`/cache/${destination.name}/attestations/${metadata.storePathHash}`,
				{ headers: { authorization: `Bearer ${token}` } }
			);
			const bundle = await readFetch(
				`/cache/${destination.name}/attestation-bundles/${digest}`,
				{ headers: { authorization: `Bearer ${token}` } }
			);
			expect(new Uint8Array(await bundle.arrayBuffer())).toStrictEqual(
				sigstoreBundleBytes(narDigestHex(metadata.narHash))
			);
			expect({
				deleted,
				references,
				listStatus: list.status,
				protections: await runInDurableObject(
					fixtureWorkerServer(),
					(instance) =>
						instance.context.db
							.select()
							.from(schema.attestationInheritances)
							.all()
				)
			}).toStrictEqual({
				deleted: {
					storePathHash: metadata.storePathHash,
					deleted: true,
					narScheduledForDeletion: false
				},
				references: [
					{ cacheKind: 'default', digest },
					{ cacheKind: 'named', digest }
				],
				listStatus: StatusCodes.OK,
				protections: []
			});
		}
	);

	it.each(['before', 'after'] as const)(
		'recovers protected inheritance after a $0 pending-clear storage fault',
		async (boundary) => {
			await withoutAlarmArming(async () => {
				const { token, metadata, bundle, digest } = await committedPathBundle();
				await attachBundle(token, metadata.storePathHash, bundle);
				await drainInheritance();
				const destination = namedCache('pending-clear-recovery');
				await putWorkerTestCache(token, destination, 'private');
				const negotiated = await authorisedWorkerFetch(
					`/cache/${destination.name}/uploads`,
					token,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							pushId: await testPushIdFor(fixtureTenant),
							paths: [uploadPathNegotiation(metadata)]
						})
					}
				);
				const decision = z
					.tuple([uploadDecisionSchema])
					.parse(
						uploadNegotiateResponseSchema.parse(await negotiated.json()).uploads
					)[0];
				if (decision.action !== 'commit') {
					throw new Error('The destination must reuse the canonical NAR.');
				}
				await deleteFixtureSource(metadata.storePathHash);
				await runInDurableObject(fixtureWorkerServer(), (_instance, state) => {
					state.storage.sql.exec(
						`CREATE TRIGGER pending_clear_fault ${boundary} DELETE ON pending_upload BEGIN SELECT RAISE(ABORT, 'pending clear fault'); END`
					);
				});
				await expect(
					commitUploadViaWorker(token, decision.uploadId, {
						tenant: fixtureTenant,
						cache: destination
					})
				).rejects.toThrow();
				const persisted = await runInDurableObject(
					fixtureWorkerServer(),
					(instance, state) => {
						const cache = resolvedCache(instance.context, destination);
						const pending = instance.context.db
							.select()
							.from(schema.pendingUploads)
							.where(eq(schema.pendingUploads.id, decision.uploadId))
							.get();
						const queue = instance.context.db
							.select()
							.from(schema.attestationInheritances)
							.where(eq(schema.attestationInheritances.cacheId, cache.id))
							.get();
						if (pending === undefined || queue === undefined) {
							throw new Error(
								'Pending work and inheritance must both be durable before clearing.'
							);
						}
						state.storage.sql.exec('DROP TRIGGER pending_clear_fault');
						return { pending, queue };
					}
				);
				expect({
					uploadId: persisted.queue.acceptedUploadId,
					acceptedSequence: persisted.queue.acceptedSequence,
					acceptedExpiresAt: persisted.queue.acceptedExpiresAt,
					commitStartedSequence: persisted.queue.commitStartedSequence
				}).toStrictEqual({
					uploadId: decision.uploadId,
					acceptedSequence: persisted.pending.acceptedSequence,
					acceptedExpiresAt: persisted.pending.acceptedExpiresAt,
					commitStartedSequence: persisted.pending.commitStartedSequence
				});
				await commitUploadViaWorker(token, decision.uploadId, {
					tenant: fixtureTenant,
					cache: destination
				});
				const recovered = await runInDurableObject(
					fixtureWorkerServer(),
					(instance) => ({
						pending: instance.context.db
							.select()
							.from(schema.pendingUploads)
							.where(eq(schema.pendingUploads.id, decision.uploadId))
							.all(),
						queue: instance.context.db
							.select()
							.from(schema.attestationInheritances)
							.where(
								eq(
									schema.attestationInheritances.cacheId,
									resolvedCache(instance.context, destination).id
								)
							)
							.get()
					})
				);
				expect(recovered).toStrictEqual({
					pending: [],
					queue: persisted.queue
				});
				await drainInheritance();
				const response = await readFetch(
					`/cache/${destination.name}/attestation-bundles/${digest}`,
					{ headers: { authorization: `Bearer ${token}` } }
				);
				expect({
					status: response.status,
					bytes: new Uint8Array(await response.arrayBuffer())
				}).toStrictEqual({ status: 200, bytes: bundle });
			}, fixtureWorkerServer());
		}
	);

	it('keeps transferred source protection after queue persistence fails to arm an alarm', async () => {
		const { metadata, destination, digest, token } =
			await reusedPathWithSourceBundle(
				'protection-transfer',
				'private',
				async (storePathHash) => {
					await deleteFixtureSource(storePathHash);
					await runInDurableObject(
						fixtureWorkerServer(),
						async (instance, state) => {
							const cache = resolvedCache(
								instance.context,
								namedCache('protection-transfer')
							);
							const pending = instance.context.db
								.select()
								.from(schema.pendingUploads)
								.where(eq(schema.pendingUploads.cacheId, cache.id))
								.get();
							if (pending === undefined) {
								throw new Error(
									'The destination upload must still be pending.'
								);
							}
							const injected = new Error(
								'alarm unavailable after inheritance persistence'
							);
							await state.storage.deleteAlarm();
							const alarm = vi
								.spyOn(state.storage, 'setAlarm')
								.mockRejectedValueOnce(injected);
							try {
								await expect(
									attestationsFor(instance.context).queueInheritance(
										cache,
										storePathHash,
										narInfoGenerationSchema.parse(0),
										pending.narHash,
										pending.id
									)
								).rejects.toBe(injected);
							} finally {
								alarm.mockRestore();
							}
							await attestationsFor(instance.context).queueInheritance(
								cache,
								storePathHash,
								narInfoGenerationSchema.parse(0),
								pending.narHash,
								pending.id
							);
							const actual = {
								pending:
									instance.context.db
										.select({ id: schema.pendingUploads.id })
										.from(schema.pendingUploads)
										.where(eq(schema.pendingUploads.id, pending.id))
										.get() !== undefined,
								queue: instance.context.db
									.select({
										storePathHash: schema.attestationInheritances.storePathHash,
										generation: schema.attestationInheritances.generation
									})
									.from(schema.attestationInheritances)
									.where(eq(schema.attestationInheritances.cacheId, cache.id))
									.all(),
								protection: instance.context.db
									.select({
										storePathHash: schema.attestationInheritances.storePathHash,
										acceptedSequence:
											schema.attestationInheritances.acceptedSequence,
										queuedSequence:
											schema.attestationInheritances.queuedSequence,
										acceptedUploadId:
											schema.attestationInheritances.acceptedUploadId
									})
									.from(schema.attestationInheritances)
									.all()
							};
							expect(actual).toStrictEqual({
								pending: true,
								queue: [{ storePathHash, generation: 0 }],
								protection: [
									{
										storePathHash,
										acceptedSequence: pending.acceptedSequence,
										queuedSequence: pending.acceptedSequence + 1,
										acceptedUploadId: pending.id
									}
								]
							});
						}
					);
				}
			);
		await drainInheritance();
		const bundle = await readFetch(
			`/cache/${destination.name}/attestation-bundles/${digest}`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(new Uint8Array(await bundle.arrayBuffer())).toStrictEqual(
			sigstoreBundleBytes(narDigestHex(metadata.narHash))
		);
	});

	it('inherits a lower-sorting bundle from a later protected source page', async () => {
		const { token, destination, metadata, digest } =
			await reusedPathWithSourceBundle('source-pages', 'private');
		const destinationCacheId = await runInDurableObject(
			fixtureWorkerServer(),
			(instance, state) => {
				state.storage.sql.exec(
					`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 99)
			INSERT INTO cache_identity(kind, name, access, priority, created_at) SELECT 'named', printf('source-page-padding-%d', value), 'public', 40, ? FROM rows`,
					isoTimestamp(new Date())
				);
				const sequence = new WorkSequenceService(instance.context.db).current();
				state.storage.sql.exec(
					`INSERT INTO narinfo_deletion(cache_id, store_path_hash, nar_hash, generation, created_at, explicit, protection_cutoff, protection_captured_at)
			SELECT id, ?, ?, 0, ?, 1, ?, ? FROM cache_identity WHERE name LIKE 'source-page-padding-%'`,
					metadata.storePathHash,
					metadata.narHash,
					isoTimestamp(new Date()),
					sequence,
					isoTimestamp(new Date())
				);
				return resolvedCache(instance.context, destination).id;
			}
		);
		const laterSource = namedCache('later-page-source');
		await putWorkerTestCache(token, laterSource);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			await verifiableNar('source-pages'),
			laterSource
		);
		const laterBundle = sigstoreBundleBytes(
			narDigestHex(metadata.narHash),
			buildOriginPredicateType
		);
		const laterDigest = sha256HexDigestSchema.parse(
			await sha256HexBytes(laterBundle)
		);
		await attachBundle(token, metadata.storePathHash, laterBundle, laterSource);
		await deleteFixtureSource(metadata.storePathHash);
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			deletionQueueFor(instance.context).deleteStorePath(
				laterSource,
				metadata.storePathHash,
				internalOrigin
			)
		);
		await drainInheritance();
		const firstPage = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const cache = resolvedCache(instance.context, destination);
				return instance.context.db
					.select({
						cacheId: schema.attestationInheritances.sourceCacheId,
						generation: schema.attestationInheritances.sourceGeneration,
						predicateType: schema.attestationInheritances.sourcePredicateType,
						digest: schema.attestationInheritances.sourceDigest
					})
					.from(schema.attestationInheritances)
					.where(eq(schema.attestationInheritances.cacheId, cache.id))
					.all()
					.map((row) => ({
						...row,
						predicateType: row.predicateType ?? undefined,
						digest: row.digest ?? undefined
					}));
			}
		);
		const firstReferences = await attestationReferenceRows();
		await drainInheritance();
		const allReferences = await attestationReferenceRows();
		const references = allReferences
			.filter(
				(row) =>
					row.cache.kind === 'named' && row.cache.name === destination.name
			)
			.map((row) => ({ predicateType: row.predicateType, digest: row.digest }))
			.toSorted((left, right) =>
				byCodeUnit(left.predicateType, right.predicateType)
			);
		expect({
			firstPage,
			firstDigests: firstReferences
				.filter(
					(row) =>
						row.cache.kind === 'named' && row.cache.name === destination.name
				)
				.map((row) => row.digest),
			references
		}).toStrictEqual({
			firstPage: [
				{
					cacheId: destinationCacheId,
					generation: 0,
					predicateType: undefined,
					digest: undefined
				}
			],
			firstDigests: [digest],
			references: [
				{ predicateType: buildOriginPredicateType, digest: laterDigest },
				{ predicateType, digest }
			]
		});
		const bundle = await readFetch(
			`/cache/${destination.name}/attestation-bundles/${laterDigest}`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(new Uint8Array(await bundle.arrayBuffer())).toStrictEqual(
			laterBundle
		);
	});

	it.each([
		'before-deletion',
		'after-deletion',
		'never-started',
		'renewed-after-deletion'
	] as const)(
		'uses the first commit sequence to decide expired work eligibility %s',
		async (phase) => {
			await withoutAlarmArming(async () => {
				const { token, metadata } = await reusedPathWithSourceBundle(
					'expiry-cutoff',
					'private'
				);
				const expired = namedCache('expired-work');
				await putWorkerTestCache(token, expired, 'private');
				const negotiated = await authorisedWorkerFetch(
					`/cache/${expired.name}/uploads`,
					token,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							pushId: await testPushIdFor(fixtureTenant),
							paths: [uploadPathNegotiation(metadata)]
						})
					}
				);
				const decision = z
					.tuple([uploadDecisionSchema])
					.parse(
						uploadNegotiateResponseSchema.parse(await negotiated.json()).uploads
					)[0];
				if (decision.action === 'skip') {
					throw new Error(
						'The expired destination must receive an upload identity.'
					);
				}
				const expiry = isoTimestamp(new Date(Date.now() - 60_000));
				await runInDurableObject(fixtureWorkerServer(), (instance) => {
					instance.context.db
						.update(schema.pendingUploads)
						.set({ expiresAt: expiry, acceptedExpiresAt: expiry })
						.where(eq(schema.pendingUploads.id, decision.uploadId))
						.run();
					if (phase === 'before-deletion') {
						new UploadStateService(instance.context).markUploadCommitting(
							decision.uploadId
						);
					}
				});
				await deleteFixtureSource(metadata.storePathHash);
				const result = await runInDurableObject(
					fixtureWorkerServer(),
					async (instance) => {
						const cache = resolvedCache(instance.context, expired);
						const pending = schema.pendingUploads;

						switch (phase) {
							case 'after-deletion': {
								new UploadStateService(instance.context).markUploadCommitting(
									decision.uploadId
								);
								break;
							}
							case 'renewed-after-deletion': {
								const state = new UploadStateService(instance.context);
								state.markUploadPending(decision.uploadId);
								await state.markUploadTerminal(
									decision.uploadId,
									'servable',
									rootLogger()
								);
								break;
							}
							default: {
								break;
							}
						}

						const first = instance.context.db
							.select()
							.from(pending)
							.where(eq(pending.id, decision.uploadId))
							.get();
						if (first === undefined) {
							throw new Error(
								'The pending destination identity must remain available.'
							);
						}
						if (phase === 'before-deletion' || phase === 'after-deletion') {
							new UploadStateService(instance.context).markUploadCommitting(
								decision.uploadId
							);
						}
						await attestationsFor(instance.context).queueInheritance(
							cache,
							metadata.storePathHash,
							narInfoGenerationSchema.parse(0),
							metadata.narHash,
							decision.uploadId
						);
						const queue = instance.context.db
							.select({
								uploadId: schema.attestationInheritances.acceptedUploadId,
								expiry: schema.attestationInheritances.acceptedExpiresAt,
								firstCommit:
									schema.attestationInheritances.commitStartedSequence
							})
							.from(schema.attestationInheritances)
							.where(eq(schema.attestationInheritances.cacheId, cache.id))
							.get();
						const source = resolvedCache(instance.context);
						const isEligible = new ProtectedInheritanceService(
							instance.context
						).isReferenceProtected(
							cache,
							metadata.storePathHash,
							narInfoGenerationSchema.parse(0),
							source.id,
							narInfoGenerationSchema.parse(0)
						);

						return {
							queue,
							firstCommit: first.commitStartedSequence,
							isEligible
						};
					}
				);
				expect(result).toStrictEqual({
					queue: {
						uploadId: decision.uploadId,
						expiry,
						firstCommit: result.firstCommit
					},
					firstCommit: result.firstCommit,
					isEligible: phase === 'before-deletion'
				});
			}, fixtureWorkerServer());
		}
	);

	it('keeps NAR presence accounted while an unreadable source remains protected', async () => {
		const { metadata, destination } = await reusedPathWithSourceBundle(
			'protected-accounting',
			'private'
		);
		await deleteFixtureSource(metadata.storePathHash);
		const before = await tenantUsageRow();
		if (before === undefined) {
			throw new Error('The published path must have tenant usage.');
		}
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			deletionQueueFor(instance.context).deleteStorePath(
				destination,
				metadata.storePathHash,
				internalOrigin
			)
		);
		expect({
			presence: await tenantBlobRows(),
			usage: await tenantUsageRow()
		}).toStrictEqual({
			presence: [
				{
					tenant: fixtureTenant,
					narHash: metadata.narHash,
					fileSize: metadata.fileSize
				}
			],
			usage: { ...before, narinfos: before.narinfos - 1 }
		});
	});

	it('does not grant an old revoked generation through a later deletion cutoff', async () => {
		const {
			token,
			destination: earlier,
			metadata,
			digest
		} = await reusedPathWithSourceBundle(
			'successive-deletion-cutoffs',
			'private'
		);
		await deleteFixtureSource(metadata.storePathHash);
		const nar = await verifiableNar('successive-deletion-cutoffs');
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		const later = namedCache('successive-deletion-later');
		await putWorkerTestCache(token, later);
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar, later);
		await deleteFixtureSource(metadata.storePathHash);
		await drainInheritance();
		await makeQueuedInheritancesDue();
		await drainInheritance();
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const rows = await database
			.select({
				cache: d1Schema.attestationReference.cacheName,
				generation: d1Schema.attestationReference.generation,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(
						d1Schema.attestationReference.storePathHash,
						metadata.storePathHash
					),
					eq(d1Schema.attestationReference.cacheKind, 'named')
				)
			)
			.orderBy(d1Schema.attestationReference.cacheName);
		expect(rows).toStrictEqual([
			{
				cache: earlier.name,
				generation: narInfoGenerationSchema.parse(0),
				digest
			}
		]);
	});

	it('replays revoked-source cleanup without revoking a replacement publication', async () => {
		const { token, metadata, digest, destination } =
			await reusedPathWithSourceBundle('replaced-deleted-source', 'private');
		await runInDurableObject(fixtureWorkerServer(), async (instance, state) => {
			const context = new ServerContext(state, {
				...instance.context.env,
				CUPBOARD_DB: flakyD1(instance.context.env.CUPBOARD_DB, {
					failures: 1,
					matches: (query) =>
						query.startsWith('insert into "path_read_revocation"')
				})
			});
			await expect(
				deletionQueueFor(context).deleteStorePath(
					defaultCacheScope,
					metadata.storePathHash,
					internalOrigin
				)
			).rejects.toThrow('transient D1 fault');
		});
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			await verifiableNar('replaced-deleted-source')
		);
		await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.criticalSection(() =>
				deletionQueueFor(instance.context).retireQueuedNarInfoEdge(
					resolvedCache(instance.context),
					metadata.storePathHash,
					narInfoGenerationSchema.parse(0)
				)
			)
		);
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const references = await database
			.select({
				generation: d1Schema.blobReference.generation,
				readable: authorisedByPathGeneration().mapWith(Boolean)
			})
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, fixtureTenant),
					eq(d1Schema.blobReference.cacheKind, 'default'),
					eq(d1Schema.blobReference.storePathHash, metadata.storePathHash)
				)
			)
			.orderBy(d1Schema.blobReference.generation);
		const narinfo = await readFetch(`/${metadata.storePathHash}.narinfo`);
		await drainInheritance();
		const inherited = await readFetch(
			`/cache/${destination.name}/attestation-bundles/${digest}`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect({
			references,
			narinfo: narinfo.status,
			inherited: inherited.status
		}).toStrictEqual({
			references: [
				{ generation: 0, readable: false },
				{ generation: 1, readable: true }
			],
			narinfo: StatusCodes.OK,
			inherited: StatusCodes.OK
		});
	});

	it('bounds bundle authority while 25,000 revoked reference generations await demotion', async () => {
		const { metadata, digest } = await reusedPathWithSourceBundle(
			'bundle-read-fence-scale',
			'private'
		);
		const source =
			'WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM source WHERE n < 24999)';
		await env.CUPBOARD_DB.prepare(
			`${source} INSERT INTO blob_ref_storage(tenant,cache_kind,store_path_hash,generation,nar_hash,cache_generation) SELECT original.tenant, original.cache_kind, original.store_path_hash, n, original.nar_hash, original.cache_generation FROM source CROSS JOIN (SELECT * FROM blob_ref_storage WHERE tenant = ? AND cache_kind = 'default' AND store_path_hash = ? AND generation = 0) original`
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.run();
		await env.CUPBOARD_DB.prepare(
			`${source} INSERT INTO attestation_ref_storage(tenant,cache_kind,store_path_hash,generation,predicate_type,digest) SELECT original.tenant, original.cache_kind, original.store_path_hash, n, original.predicate_type, original.digest FROM source CROSS JOIN (SELECT * FROM attestation_ref_storage WHERE tenant = ? AND cache_kind = 'default' AND store_path_hash = ? AND generation = 0) original`
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.run();
		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM source WHERE n < 25000) INSERT INTO attestation_ref_storage(tenant,cache_kind,store_path_hash,generation,predicate_type,digest) SELECT original.tenant, original.cache_kind, original.store_path_hash, 0, original.predicate_type, printf('%064x',n) FROM source CROSS JOIN (SELECT * FROM attestation_ref_storage WHERE tenant = ? AND cache_kind = 'default' AND store_path_hash = ? AND generation = 0 LIMIT 1) original`
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.run();
		const statements: { query: string; values: unknown[] }[] = [];
		const binding: D1Database = {
			prepare(query) {
				const statement = env.CUPBOARD_DB.prepare(query);
				if (
					query.includes('path_read_revocation') &&
					query.includes('from "attestation_ref_storage"')
				) {
					const bind = statement.bind.bind(statement);
					statement.bind = (...values: unknown[]) => {
						statements.push({ query, values });
						return bind(...values);
					};
				}
				return statement;
			},
			batch: (statements) => env.CUPBOARD_DB.batch(statements),
			exec: (query) => env.CUPBOARD_DB.exec(query),
			withSession: (constraint) => env.CUPBOARD_DB.withSession(constraint),
			dump: () =>
				Promise.reject(new Error('The bundle scale fixture does not dump D1.'))
		};
		await runInDurableObject(fixtureWorkerServer(), async (instance, state) => {
			const context = new ServerContext(state, {
				...instance.context.env,
				CUPBOARD_DB: binding
			});
			const authority = new PathReadAuthorityService(context);
			await authority.revoke(resolvedCache(context), [
				{
					storePathHash: metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(24_999)
				}
			]);
			await expect(
				attestationsFor(context).handleServeBundle(
					new Request('https://example.com/bundle'),
					defaultCacheScope,
					digest
				)
			).rejects.toBeInstanceOf(SharedFactsUnavailableError);
		});
		const [query] = statements;
		if (query === undefined) {
			throw new Error('The bundle read did not prepare an authority query.');
		}
		const measured = await env.CUPBOARD_DB.prepare(query.query)
			.bind(...query.values)
			.all();
		const plan = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN ${query.query}`
		)
			.bind(...query.values)
			.all();
		expect({
			queries: statements.length,
			candidates: measured.results.length,
			read: measured.meta.rows_read,
			plan: plan.results.map((row) => row.detail)
		}).toStrictEqual({
			queries: 1,
			candidates: 65,
			read: 324,
			plan: [
				'SEARCH attestation_ref_storage USING COVERING INDEX attestation_ref_readable_digest_idx (tenant=? AND cache_kind=? AND cache_name=? AND digest=?)',
				'SEARCH blob_ref_storage USING INDEX blob_ref_default_identity_idx (tenant=? AND store_path_hash=? AND generation=?)',
				'SEARCH cache_lifecycle_storage USING INDEX cache_lifecycle_native_identity_idx (tenant=? AND cache_kind=? AND cache_name=?)',
				'CORRELATED SCALAR SUBQUERY 1',
				'SEARCH path_read_revocation USING INDEX path_read_revocation_native_identity_idx (tenant=? AND cache_kind=? AND cache_name=? AND store_path_hash=?)'
			]
		});
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const authority = new PathReadAuthorityService(instance.context);
			for (let page = 0; page < 500; page++) {
				await authority.drain();
			}
			await authority.drain();
			expect(await authority.hasPending()).toBe(false);
		});
		const demoted = await env.CUPBOARD_DB.prepare(query.query)
			.bind(...query.values)
			.all();
		await env.CUPBOARD_DB.prepare(
			`INSERT INTO blob_ref_storage(tenant,cache_kind,store_path_hash,generation,nar_hash,cache_generation) SELECT tenant, cache_kind, store_path_hash, 25000, nar_hash, cache_generation FROM blob_ref_storage WHERE tenant = ? AND cache_kind = 'default' AND store_path_hash = ? AND generation = 0`
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.run();
		await env.CUPBOARD_DB.prepare(
			`INSERT INTO attestation_ref_storage(tenant,cache_kind,store_path_hash,generation,predicate_type,digest) SELECT tenant, cache_kind, store_path_hash, 25000, predicate_type, digest FROM attestation_ref_storage WHERE tenant = ? AND cache_kind = 'default' AND store_path_hash = ? AND generation = 0 AND digest = ?`
		)
			.bind(fixtureTenant, metadata.storePathHash, digest)
			.run();
		const later = await env.CUPBOARD_DB.prepare(query.query)
			.bind(...query.values)
			.all();
		const status = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const response = await attestationsFor(
					instance.context
				).handleServeBundle(
					new Request('https://example.com/bundle'),
					defaultCacheScope,
					digest
				);
				return response.status;
			}
		);
		expect({
			demoted: { rows: demoted.results, read: demoted.meta.rows_read },
			later: { rows: later.results, read: later.meta.rows_read },
			status
		}).toStrictEqual({
			demoted: { rows: [], read: 0 },
			later: { rows: [{ digest, available: 1 }], read: 5 },
			status: StatusCodes.OK
		});
	});
	it.each(['current', 'preceding'] as const)(
		'refuses recovered source reads from the %s writer after demotion',
		async (writer) => {
			const { metadata, digest, destination, token } =
				await reusedPathWithSourceBundle('demoted-source-recovery', 'private');
			await deleteFixtureSource(metadata.storePathHash);
			const recovered = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance) => {
					const context = instance.context;
					await new PathReadAuthorityService(context).drain();
					await context.d1
						.delete(d1Schema.attestationReference)
						.where(
							and(
								eq(d1Schema.attestationReference.tenant, fixtureTenant),
								eq(d1Schema.attestationReference.cacheKind, 'default'),
								eq(
									d1Schema.attestationReference.storePathHash,
									metadata.storePathHash
								)
							)
						);
					const result = await new AttestationCasService(
						context
					).reserveReferenceAndCharge(
						{
							cache: defaultCacheScope,
							storePathHash: metadata.storePathHash,
							generation: narInfoGenerationSchema.parse(0),
							predicateType: predicateTypeSchema.parse(
								buildOriginPredicateType
							),
							digest
						},
						1
					);
					if (writer === 'preceding') {
						await expect(
							env.CUPBOARD_DB.batch([
								env.CUPBOARD_DB.prepare(
									"DELETE FROM attestation_ref WHERE tenant = ? AND cache_kind = 'default' AND store_path_hash = ?"
								).bind(fixtureTenant, metadata.storePathHash),
								env.CUPBOARD_DB.prepare(
									"INSERT INTO attestation_ref(tenant, cache_kind, store_path_hash, generation, predicate_type, digest) SELECT id, 'default', ?, 0, ?, ? FROM tenant WHERE id = ? AND status = 'active' ON CONFLICT DO NOTHING"
								).bind(
									metadata.storePathHash,
									buildOriginPredicateType,
									digest,
									fixtureTenant
								)
							])
						).rejects.toThrow(
							'cannot modify attestation_ref because it is a view'
						);
					}
					const row = await context.d1
						.select({ readable: d1Schema.attestationReference.readable })
						.from(d1Schema.attestationReference)
						.where(
							and(
								eq(d1Schema.attestationReference.tenant, fixtureTenant),
								eq(d1Schema.attestationReference.cacheKind, 'default'),
								eq(
									d1Schema.attestationReference.storePathHash,
									metadata.storePathHash
								)
							)
						)
						.get();
					return { result, row };
				}
			);
			await drainInheritance();
			const response = await readFetch(
				`/cache/${destination.name}/attestation-bundles/${digest}`,
				{ headers: { authorization: `Bearer ${token}` } }
			);
			const source = await readFetch(`/attestation-bundles/${digest}`, {
				headers: { authorization: `Bearer ${token}` }
			});
			expect({
				recovered,
				inherited: response.status,
				source: source.status
			}).toStrictEqual({
				recovered: {
					result: 'referenced',
					row: { readable: false }
				},
				inherited: StatusCodes.OK,
				source: StatusCodes.NOT_FOUND
			});
		}
	);
	it.each(['before-revocation', 'after-revocation'] as const)(
		'redrives explicit deletion after a failure $0',
		async (boundary) => {
			const { metadata } = await reusedPathWithSourceBundle(
				`deletion-${boundary}`,
				'private'
			);
			const interruption = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance, state) => {
					const injected = new Error('interrupted explicit deletion');

					const inner = instance.context.env.CUPBOARD_DB;
					let isRevocation = false;
					const binding: D1Database = {
						prepare(query) {
							if (query.startsWith('insert into "path_read_revocation"')) {
								isRevocation = true;
							}
							return inner.prepare(query);
						},
						async batch<T>(statements: D1PreparedStatement[]) {
							if (isRevocation) {
								isRevocation = false;
								if (boundary === 'before-revocation') {
									throw injected;
								}
								await inner.batch<T>(statements);
								throw injected;
							}
							return inner.batch<T>(statements);
						},
						exec: (query) => inner.exec(query),
						withSession: (constraint) => inner.withSession(constraint),
						dump: () =>
							Promise.reject(new Error('The fault fixture does not dump D1.'))
					};
					const context = new ServerContext(state, {
						...instance.context.env,
						CUPBOARD_DB: binding
					});
					try {
						await deletionQueueFor(context).deleteStorePath(
							defaultCacheScope,
							metadata.storePathHash,
							internalOrigin
						);
						return false;
					} catch (error) {
						const fence = await inner
							.prepare(
								'SELECT generation FROM path_read_revocation WHERE tenant = ? AND cache_kind = ? AND store_path_hash = ?'
							)
							.bind(fixtureTenant, 'default', metadata.storePathHash)
							.first();
						return {
							interrupted: error === injected,
							fence: fence ?? undefined,
							pending: await state.storage.get(pathReadDemotionPendingKey)
						};
					}
				}
			);
			const retried = await deleteFixtureSource(metadata.storePathHash);
			const protectedRows = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					instance.context.db
						.select({
							storePathHash: schema.attestationInheritances.storePathHash,
							generation: schema.attestationInheritances.generation
						})
						.from(schema.attestationInheritances)
						.all()
			);
			expect({
				interruption,
				retried,
				protections: protectedRows
			}).toStrictEqual({
				interruption: {
					interrupted: true,
					fence:
						boundary === 'after-revocation' ? { generation: 0 } : undefined,
					pending: true
				},
				retried: {
					storePathHash: metadata.storePathHash,
					deleted: true,
					narScheduledForDeletion: false
				},
				protections: [
					{
						storePathHash: metadata.storePathHash,
						generation: 0
					}
				]
			});
			await drainInheritance();
		}
	);

	it('does not reference or list bundles for a generation that the path no longer has', async () => {
		const { destination, metadata, token } = await reusedPathWithSourceBundle(
			'superseded-inheritance'
		);
		const ownBundle = sigstoreBundleBytes(
			narDigestHex(metadata.narHash),
			buildOriginPredicateType
		);
		const ownDigest = sha256HexDigestSchema.parse(
			await sha256HexBytes(ownBundle)
		);
		await attachBundle(token, metadata.storePathHash, ownBundle, destination);

		const result = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			attestationsFor(instance.context).inheritFromTenant(rootLogger(), {
				cache: resolvedCache(instance.context, destination),
				storePathHash: metadata.storePathHash,
				generation: narInfoGenerationSchema.parse(1),
				narHash: metadata.narHash
			})
		);
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);
		const references = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({ generation: d1Schema.attestationReference.generation })
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.cacheName, destination.name),
					eq(
						d1Schema.attestationReference.storePathHash,
						metadata.storePathHash
					)
				)
			);

		expect({
			result,
			listed: attestationListSchema
				.parse(await list.json())
				.attestations.map((attestation) => attestation.digest),
			generations: references.map((row) => row.generation)
		}).toStrictEqual({
			result: 'superseded',
			listed: [ownDigest],
			generations: [narInfoGenerationSchema.parse(0)]
		});
	});

	it('defers a pending source incarnation without counting a failed inheritance attempt', async () => {
		const { destination, metadata, digest } = await reusedPathWithSourceBundle(
			'pending-incarnation'
		);
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const filter = and(
			eq(d1Schema.objectIncarnation.kind, 'cas'),
			eq(d1Schema.objectIncarnation.objectId, digest)
		);
		await database
			.update(d1Schema.objectIncarnation)
			.set({ state: 'pending' })
			.where(filter);
		const deferred = await drainInheritance();
		const queued = await queuedInheritances();
		await database
			.update(d1Schema.objectIncarnation)
			.set({ state: 'live' })
			.where(filter);
		await makeQueuedInheritancesDue();
		const completed = await drainInheritance();
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);
		expect({
			deferred,
			queued,
			completed,
			remaining: await queuedInheritances(),
			listStatus: list.status
		}).toStrictEqual({
			deferred: 'progressed',
			queued: [{ storePathHash: metadata.storePathHash, attempts: 0 }],
			completed: 'progressed',
			remaining: [],
			listStatus: StatusCodes.OK
		});
	});

	it.each(['before-head', 'after-head', 'registry-only'] as const)(
		'preserves inheritance progress when a CAS incarnation changes %s',
		async (phase) => {
			const { token, destination, metadata, digest } =
				await reusedPathWithSourceBundle(`incarnation-${phase}`);
			const earlierBundle = sigstoreBundleBytes(
				narDigestHex(metadata.narHash),
				buildOriginPredicateType
			);
			const earlierDigest = sha256HexDigestSchema.parse(
				await sha256HexBytes(earlierBundle)
			);
			await attachBundle(token, metadata.storePathHash, earlierBundle);
			const key = await currentCasObjectKey(digest);
			const oldObject = await env.BLOBS.get(key);
			if (oldObject === null) {
				throw new Error('The inheritance fixture needs its source bundle.');
			}
			const bytes = await oldObject.arrayBuffer();
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const originalHead = env.BLOBS.head.bind(env.BLOBS);
			let wasReplaced = false;
			const head = vi
				.spyOn(env.BLOBS, 'head')
				.mockImplementation(async (keyToRead) => {
					if (keyToRead !== key || wasReplaced) {
						return originalHead(keyToRead);
					}
					wasReplaced = true;
					const captured =
						phase === 'after-head' ? await originalHead(key) : undefined;
					await env.BLOBS.put(casObjectKey(digest, 3), bytes);
					if (phase !== 'registry-only') {
						await database
							.update(d1Schema.casObject)
							.set({ incarnation: 3 })
							.where(eq(d1Schema.casObject.digest, digest));
					}
					await database
						.update(d1Schema.objectIncarnation)
						.set({ incarnation: 3 })
						.where(
							and(
								eq(d1Schema.objectIncarnation.kind, 'cas'),
								eq(d1Schema.objectIncarnation.objectId, digest)
							)
						);
					await env.BLOBS.delete(key);
					return captured ?? originalHead(key);
				});
			try {
				await drainInheritance();
			} finally {
				head.mockRestore();
			}
			const afterChange = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					instance.context.db
						.select({
							storePathHash: schema.attestationInheritances.storePathHash,
							attempts: schema.attestationInheritances.attempts,
							sourcePredicateType:
								schema.attestationInheritances.sourcePredicateType,
							sourceDigest: schema.attestationInheritances.sourceDigest
						})
						.from(schema.attestationInheritances)
						.all()
			);
			await database
				.update(d1Schema.casObject)
				.set({ incarnation: 3 })
				.where(eq(d1Schema.casObject.digest, digest));
			await makeQueuedInheritancesDue();
			await drainInheritance();
			const list = await readFetch(
				`/cache/${destination.name}/attestations/${metadata.storePathHash}`
			);
			expect({
				afterChange,
				queued: await queuedInheritances(),
				listed: list.ok
					? attestationListSchema
							.parse(await list.json())
							.attestations.map((row) => row.digest)
							.toSorted(byCodeUnit)
					: []
			}).toStrictEqual({
				afterChange: [
					{
						storePathHash: metadata.storePathHash,
						attempts: 1,
						sourcePredicateType: buildOriginPredicateType,
						sourceDigest: earlierDigest
					}
				],
				queued: [],
				listed: [earlierDigest, digest].toSorted(byCodeUnit)
			});
		}
	);

	it.each([
		{ phase: 'initial-fetch', state: 'pending' },
		{ phase: 'initial-fetch', state: 'live' },
		{ phase: 'after-head', state: 'pending' },
		{ phase: 'after-head', state: 'live' }
	] as const)(
		'retries inheritance with missing CAS metadata $phase while the replacement is $state',
		async ({ phase, state }) => {
			const { token, destination, metadata, digest } =
				await reusedPathWithSourceBundle(`missing-cas-${phase}-${state}`);
			const earlierBundle = sigstoreBundleBytes(
				narDigestHex(metadata.narHash),
				buildOriginPredicateType
			);
			const earlierDigest = sha256HexDigestSchema.parse(
				await sha256HexBytes(earlierBundle)
			);
			await attachBundle(token, metadata.storePathHash, earlierBundle);
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const captured = await database
				.select()
				.from(d1Schema.casObject)
				.where(eq(d1Schema.casObject.digest, digest))
				.get();
			if (captured === undefined) {
				throw new Error('The inheritance fixture needs its CAS metadata.');
			}
			const key = casObjectKey(digest, captured.incarnation);
			const object = await env.BLOBS.get(key);
			if (object === null) {
				throw new Error('The inheritance fixture needs its source bundle.');
			}
			const bytes = await object.arrayBuffer();
			const replacement = captured.incarnation + 1;
			const removeCaptured = async () => {
				await database
					.update(d1Schema.objectIncarnation)
					.set({ incarnation: replacement, state })
					.where(
						and(
							eq(d1Schema.objectIncarnation.kind, 'cas'),
							eq(d1Schema.objectIncarnation.objectId, digest)
						)
					);
				await env.BLOBS.put(casObjectKey(digest, replacement), bytes);
				await env.BLOBS.delete(key);
				await runInDurableObject(fixtureWorkerServer(), (instance) =>
					new AttestationCasService(instance.context).removeCapturedReference(
						{
							cache: defaultCacheScope,
							storePathHash: metadata.storePathHash,
							generation: narInfoGenerationSchema.parse(0),
							predicateType: predicateTypeSchema.parse(predicateType),
							digest
						},
						captured.incarnation
					)
				);
				const deletion = fencedCasObjectDeletion(
					database,
					jsonRowList([{ digest, incarnation: captured.incarnation }])
				);
				await database.batch([deletion.retire, deletion.remove]);
			};
			const originalHead = env.BLOBS.head.bind(env.BLOBS);
			const head = vi
				.spyOn(env.BLOBS, 'head')
				.mockImplementation(async (requested) => {
					const result = await originalHead(requested);
					if (phase === 'after-head' && requested === key) {
						await removeCaptured();
					}
					return result;
				});
			try {
				if (phase === 'initial-fetch') {
					await removeCaptured();
				}
				await drainInheritance();
			} finally {
				head.mockRestore();
			}
			const afterGap = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					instance.context.db
						.select({
							storePathHash: schema.attestationInheritances.storePathHash,
							attempts: schema.attestationInheritances.attempts,
							sourcePredicateType:
								schema.attestationInheritances.sourcePredicateType,
							sourceDigest: schema.attestationInheritances.sourceDigest
						})
						.from(schema.attestationInheritances)
						.all()
			);
			const sourceReferences = await database
				.select({ digest: d1Schema.attestationReference.digest })
				.from(d1Schema.attestationReference)
				.where(
					and(
						eq(d1Schema.attestationReference.digest, digest),
						eq(d1Schema.attestationReference.cacheKind, 'default')
					)
				);
			await database
				.update(d1Schema.objectIncarnation)
				.set({ state: 'live' })
				.where(
					and(
						eq(d1Schema.objectIncarnation.kind, 'cas'),
						eq(d1Schema.objectIncarnation.objectId, digest)
					)
				);
			await database.insert(d1Schema.casObject).values({
				...captured,
				incarnation: replacement
			});
			await makeQueuedInheritancesDue();
			const retryCalls = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					withSubrequestSlice(
						async () => {
							const before = subrequestsAvailable();
							await attestationsFor(instance.context).drainInheritanceQueue(
								rootLogger()
							);
							return before - subrequestsAvailable();
						},
						{ subrequests: 10, reserve: 0 }
					)
			);
			const list = await readFetch(
				`/cache/${destination.name}/attestations/${metadata.storePathHash}`
			);
			expect({
				afterGap,
				sourceReferences,
				retryCalls,
				queued: await queuedInheritances(),
				listed: list.ok
					? attestationListSchema
							.parse(await list.json())
							.attestations.map((row) => row.digest)
							.toSorted(byCodeUnit)
					: []
			}).toStrictEqual({
				afterGap: [
					{
						storePathHash: metadata.storePathHash,
						attempts: state === 'pending' ? 0 : 1,
						sourcePredicateType: buildOriginPredicateType,
						sourceDigest: earlierDigest
					}
				],
				sourceReferences: [{ digest }],
				retryCalls: 10,
				queued: [],
				listed: [earlierDigest, digest].toSorted(byCodeUnit)
			});
		}
	);

	it('lists the bundles that an attempt inherited before it failed', async () => {
		const destination = namedCache('partial-inheritance');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('partial-inheritance');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		const bundles = [
			sigstoreBundleBytes(narDigestHex(nar.narHash)),
			sigstoreBundleBytes(narDigestHex(nar.narHash), buildOriginPredicateType)
		];

		for (const bundle of bundles) {
			await attachBundle(token, metadata.storePathHash, bundle);
		}

		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		let casHeads = 0;
		// The first bundle is referenced; the head of the second bundle fails.
		const failing = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key: string) => {
				if (key.startsWith('cas/')) {
					casHeads += 1;

					if (casHeads === 2) {
						return Promise.reject(new Error('head failed'));
					}
				}

				return originalHead(key);
			});

		try {
			await drainInheritance();
		} finally {
			failing.mockRestore();
		}

		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			queued: await queuedInheritances(),
			listStatus: list.status,
			listed: list.ok
				? attestationListSchema.parse(await list.json()).attestations.length
				: 0
		}).toStrictEqual({
			queued: [{ storePathHash: metadata.storePathHash, attempts: 1 }],
			listStatus: StatusCodes.OK,
			listed: 1
		});
	});

	it.each([
		{ destinationAccess: 'public' },
		{ destinationAccess: 'private' }
	] satisfies {
		destinationAccess: CacheAccessMode;
	}[])(
		'keeps private source bundles private when the destination is $destinationAccess',
		async ({ destinationAccess }) => {
			const source = namedCache('private-source');
			const destination = namedCache(`${destinationAccess}-reused`);
			const token = await initialiseViaWorker();
			await putWorkerTestCache(token, source, 'private');
			await putWorkerTestCache(token, destination, destinationAccess);
			const nar = await verifiableNar('attestation-private-reused-path');
			const metadata = uploadMetadata({
				storePathHash: uniqueStorePathHash(),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			await pushPathThroughTenant(fixtureTenant, token, metadata, nar, source);
			const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
			const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
			await attachBundle(token, metadata.storePathHash, bundle, source);
			await pushPathThroughTenant(
				fixtureTenant,
				token,
				metadata,
				nar,
				destination
			);
			await drainInheritance();
			await provisionFixtureTenant({
				read: { user: 'alice', password: 'secret' }
			});
			const authorised = {
				headers: { authorization: `Basic ${btoa('alice:secret')}` }
			};

			const list = await readFetch(
				`/cache/${destination.name}/attestations/${metadata.storePathHash}`,
				authorised
			);
			const bundleRead = await readFetch(
				`/cache/${destination.name}/attestation-bundles/${digest}`,
				authorised
			);

			expect({
				listStatus: list.status,
				bundleStatus: bundleRead.status,
				list: list.ok
					? attestationListSchema.parse(await list.json())
					: undefined
			}).toStrictEqual({
				listStatus: StatusCodes.NOT_FOUND,
				bundleStatus: StatusCodes.NOT_FOUND,
				list: undefined
			});
		}
	);

	it('inherits a private cache attestation from its earlier path generation', async () => {
		const cache = namedCache('private-recommit');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, cache, 'private');
		const nar = await verifiableNar('private-recommit-attestation');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar, cache);
		const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		await attachBundle(token, metadata.storePathHash, bundle, cache);
		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));
		await runReaperDemote(rootLogger(), env);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			cache,
			async () => {
				await runInDurableObject(fixtureWorkerServer(), async (instance) => {
					const resolved = resolvedCache(instance.context, cache);
					const queued = instance.context.db
						.select()
						.from(schema.narInfoDeletions)
						.where(eq(schema.narInfoDeletions.cacheId, resolved.id))
						.all();
					expect(
						queued.map((row) => ({
							generation: row.generation,
							storePathHash: row.storePathHash
						}))
					).toStrictEqual([
						{
							generation: narInfoGenerationSchema.parse(0),
							storePathHash: metadata.storePathHash
						}
					]);
					const narInfoObjects = new NarInfoObjectsService(instance.context);
					const attestationCas = new AttestationCasService(instance.context);
					const attestations = new AttestationsService(
						instance.context,
						new CacheRegistrationService(instance.context),
						attestationCas,
						narInfoObjects
					);
					const deletionQueue = new DeletionQueueService(
						instance.context,
						attestationCas,
						attestations,
						narInfoObjects
					);

					await instance.context.criticalSection(() =>
						deletionQueue.retireTornDownNarInfos(resolved, queued)
					);
				});
			}
		);
		// The commit has cleared its pending upload, and the new generation is
		// in the inheritance queue. Retirement still defers the queued edge.
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const resolved = resolvedCache(instance.context, cache);
			const queued = instance.context.db
				.select()
				.from(schema.narInfoDeletions)
				.where(eq(schema.narInfoDeletions.cacheId, resolved.id))
				.all();
			const narInfoObjects = new NarInfoObjectsService(instance.context);
			const attestationCas = new AttestationCasService(instance.context);
			const deletionQueue = new DeletionQueueService(
				instance.context,
				attestationCas,
				attestationsFor(instance.context),
				narInfoObjects
			);

			await instance.context.criticalSection(() =>
				deletionQueue.retireTornDownNarInfos(resolved, queued)
			);
		});
		await drainInheritance();
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const references = await database
			.select({ generation: d1Schema.attestationReference.generation })
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.digest, digest));
		const edge = await database
			.select({ generation: d1Schema.blobReference.generation })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, fixtureTenant),
					eq(d1Schema.blobReference.cacheName, cache.name),
					eq(d1Schema.blobReference.storePathHash, metadata.storePathHash)
				)
			)
			.orderBy(desc(d1Schema.blobReference.generation))
			.get();

		expect({
			currentGeneration: edge?.generation,
			generations: references.map((row) => row.generation)
		}).toStrictEqual({
			currentGeneration: narInfoGenerationSchema.parse(1),
			generations: [
				narInfoGenerationSchema.parse(0),
				narInfoGenerationSchema.parse(1)
			]
		});
	});

	it('rejects a bundle filed against a different NAR subject', async () => {
		const token = await initialiseViaWorker();
		const storePathHash = uniqueStorePathHash();
		const nar = await verifiableNar('attestation-subject-good');
		const metadata = uploadMetadata({
			storePathHash,
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		const other = await verifiableNar('attestation-subject-wrong');
		const bundle = sigstoreBundleBytes(narDigestHex(other.narHash));

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			bundle
		);
		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			listStatus: list.status
		}).toStrictEqual({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			body: {
				defined: false,
				code: 'UNPROCESSABLE_CONTENT',
				status: StatusCodes.UNPROCESSABLE_ENTITY,
				data: undefined
			},
			refs: [],
			objects: [],
			listStatus: StatusCodes.NOT_FOUND
		});
	});

	it('returns the completed attachment when the client repeats its upload ID', async () => {
		const { token, metadata, bundle } = await committedPathBundle();
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });
		const path = `/attestations/${decision.uploadId}/attach`;
		const first = await authorisedWorkerFetch(path, token, { method: 'POST' });
		const repeated = await authorisedWorkerFetch(path, token, {
			method: 'POST'
		});

		expect({
			first: {
				status: first.status,
				body: await first.json()
			},
			repeated: {
				status: repeated.status,
				body: await repeated.json()
			}
		}).toStrictEqual({
			first: {
				status: StatusCodes.OK,
				body: {
					storePathHash: metadata.storePathHash,
					digest,
					predicateType: 'https://slsa.dev/provenance/v1',
					status: 'attached'
				}
			},
			repeated: {
				status: StatusCodes.OK,
				body: {
					storePathHash: metadata.storePathHash,
					digest,
					predicateType: 'https://slsa.dev/provenance/v1',
					status: 'already-present'
				}
			}
		});
	});

	it('rejects non-DSSE Sigstore content without filing a CAS object', async () => {
		const { token, metadata } = await committedPathBundle();
		const encoder = new TextEncoder();
		const garbage = encoder.encode('not a sigstore bundle');

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			garbage
		);
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			body: {
				defined: false,
				code: 'UNPROCESSABLE_CONTENT',
				status: StatusCodes.UNPROCESSABLE_ENTITY,
				data: undefined
			},
			refs: [],
			objects: []
		});
	});

	it('does not materialise a missing descriptor list during a read', async () => {
		const { token, metadata, bundle } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		const key = attestationListObjectKey(
			fixtureTenant,
			metadata.storePathHash,
			{ kind: 'default' }
		);
		await env.BLOBS.delete(key);
		const beforeRead = {
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			descriptorPresent: (await env.BLOBS.head(key)) !== null
		};

		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const head = await readFetch(`/attestations/${metadata.storePathHash}`, {
			method: 'HEAD'
		});

		expect({
			getStatus: list.status,
			headStatus: head.status,
			beforeRead,
			afterRead: {
				refs: await attestationReferenceRows(),
				objects: await casObjectRows(),
				descriptorPresent: (await env.BLOBS.head(key)) !== null
			}
		}).toStrictEqual({
			getStatus: StatusCodes.NOT_FOUND,
			headStatus: StatusCodes.NOT_FOUND,
			beforeRead,
			afterRead: beforeRead
		});
	});

	it('gates descriptor and bundle reads in private mode', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		await provisionFixtureTenant({
			defaultCacheAccess: 'private',
			read: { user: 'alice', password: 'secret' }
		});
		const authorised = {
			headers: { authorization: `Basic ${btoa('alice:secret')}` }
		};

		const listDenied = await readFetch(
			`/attestations/${metadata.storePathHash}`
		);
		const list = await readFetch(
			`/attestations/${metadata.storePathHash}`,
			authorised
		);
		const bundleDenied = await readFetch(`/attestation-bundles/${digest}`);
		const bundleRead = await readFetch(
			`/attestation-bundles/${digest}`,
			authorised
		);

		expect({
			listDenied: listDenied.status,
			list: list.status,
			listControl: list.headers.get('cache-control'),
			bundleDenied: bundleDenied.status,
			bundle: bundleRead.status,
			bundleControl: bundleRead.headers.get('cache-control')
		}).toStrictEqual({
			listDenied: StatusCodes.UNAUTHORIZED,
			list: StatusCodes.OK,
			listControl: 'no-store',
			bundleDenied: StatusCodes.UNAUTHORIZED,
			bundle: StatusCodes.OK,
			bundleControl: 'no-store'
		});
	});

	it('negotiates reuse only from this tenant own attestation edges', async () => {
		const { token, metadata, bundle, digest, nar } =
			await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		const issuer = await provisionNamedTenant('other');
		const otherToken = await issueTokenForTenant(
			testServerFor('other'),
			issuer,
			cacheWriteGrants()
		);
		await pushPathThroughTenant('other', otherToken, metadata, nar);

		const own = await negotiate(token, metadata.storePathHash, digest);
		const other = await negotiateTenant(
			'other',
			otherToken,
			metadata.storePathHash,
			digest
		);
		const otherUpload = attestationUploadDecisionSchema.parse(other);

		expect({
			own,
			other: otherUpload,
			pending: await pendingAttestationRowsFor('other')
		}).toStrictEqual({
			own: {
				action: 'skip',
				storePathHash: metadata.storePathHash,
				digest
			},
			other: {
				action: 'upload',
				storePathHash: metadata.storePathHash,
				digest,
				uploadId: otherUpload.uploadId,
				r2Key: otherUpload.r2Key,
				expiresAt: otherUpload.expiresAt
			},
			pending: [
				{
					id: otherUpload.uploadId,
					r2Key: otherUpload.r2Key,
					expiresAt: otherUpload.expiresAt
				}
			]
		});
	});

	it('404s a referenced bundle whose shared CAS object is absent', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		await env.BLOBS.delete(await currentCasObjectKey(digest));

		const response = await readFetch(`/attestation-bundles/${digest}`);

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('rejects over-quota attach before promoting a CAS object', async () => {
		const { token, metadata, nar, bundle, digest } =
			await committedPathBundle();
		const quotaBytes = nar.narBytes.byteLength + bundle.byteLength - 1;
		await provisionFixtureTenant({ quotaBytes });

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			bundle
		);

		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			objects: await casObjectRows(),
			casObjectPresent:
				(await env.BLOBS.head(casObjectKey(digest, 2))) !== null,
			usage: await tenantUsageRow()
		}).toStrictEqual({
			status: StatusCodes.INSUFFICIENT_STORAGE,
			body: {
				defined: false,
				code: 'INSUFFICIENT_STORAGE',
				status: StatusCodes.INSUFFICIENT_STORAGE,
				data: undefined
			},
			refs: [],
			presence: [],
			objects: [],
			casObjectPresent: false,
			usage: {
				bytes: nar.narBytes.byteLength,
				narinfos: 1,
				blobs: 1,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes
			}
		});
	});

	it('does not file an attestation against a generation replaced during attach', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		const replacement = await verifiableNar('attestation-race-replacement');
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const error = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const cache = resolvedCache(instance.context);

				class RacingAttestationCasService extends AttestationCasService {
					override async measureStagedBundle(
						key: R2ObjectKey
					): ReturnType<typeof instance.measureAttestationBundle> {
						const measured = await super.measureStagedBundle(key);
						instance.context.db
							.update(schema.narInfos)
							.set({
								narHash: replacement.narHash,
								generation: narInfoGenerationSchema.parse(1)
							})
							.where(
								and(
									eq(schema.narInfos.cacheId, cache.id),
									eq(schema.narInfos.storePathHash, metadata.storePathHash)
								)
							)
							.run();

						return measured;
					}
				}
				const attestations = new AttestationsService(
					instance.context,
					new CacheRegistrationService(instance.context),
					new RacingAttestationCasService(instance.context),
					new NarInfoObjectsService(instance.context)
				);

				try {
					return await attestations.attach(cache.scope, decision.uploadId);
				} catch (error: unknown) {
					return error;
				}
			}
		);
		expect(error).toBeInstanceOf(AttestationPathNotFoundError);
		if (!(error instanceof AttestationPathNotFoundError)) {
			throw error;
		}

		expect({
			error: {
				name: error.name,
				status: error.status,
				storePathHash: error.storePathHash
			},
			refs: await attestationReferenceRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			error: {
				name: AttestationPathNotFoundError.name,
				status: StatusCodes.NOT_FOUND,
				storePathHash: metadata.storePathHash
			},
			refs: [],
			objects: []
		});
	});

	it('garbage-collects expired pending attestation uploads and staging objects', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const { token, metadata, bundle, digest } = await committedPathBundle();
		const existingPending = await pendingAttestationRows();
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const expiredPending = {
			id: decision.uploadId,
			r2Key: decision.r2Key,
			expiresAt: '2026-01-01T00:15:00.000Z'
		};
		expect(await pendingAttestationRows()).toStrictEqual(
			[...existingPending, expiredPending].toSorted(compareById)
		);
		await expect(env.BLOBS.head(decision.r2Key)).resolves.not.toBeNull();

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));

		await fixtureWorkerServer().runGarbageCollection();

		expect(await pendingAttestationRows()).toStrictEqual(existingPending);
		await expect(env.BLOBS.head(decision.r2Key)).resolves.toBeNull();
	});

	it('rejects an oversized bundle from metadata without filing a CAS object', async () => {
		const { token, metadata } = await committedPathBundle();
		const bundle = new Uint8Array(1024 * 1024 + 1);
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const response = await authorisedWorkerFetch(
			`/attestations/${decision.uploadId}/attach`,
			token,
			{ method: 'POST' }
		);

		const staging = await env.BLOBS.head(decision.r2Key);
		const pending = await pendingAttestationRows();
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			pending: pending.filter((row) => row.id === decision.uploadId),
			stagingPresent: staging !== null
		}).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			body: {
				defined: false,
				code: 'PAYLOAD_TOO_LARGE',
				status: StatusCodes.REQUEST_TOO_LONG,
				data: undefined
			},
			refs: [],
			objects: [],
			pending: [],
			stagingPresent: false
		});
	});

	// A re-run of `cupboard attest` over an unchanged closure sends one bundle for
	// each already-attested path, and negotiate heads the CAS object of every one
	// whose path is committed and whose digest it already records. A bundle's
	// digest is the hash of its own document, so no two bundles in a closure
	// share one and the deduplication by digest saves nothing. One page of
	// bundles therefore costs one subrequest each, and a page larger than the
	// invocation's subrequests cannot be served at all: the call that exceeds
	// the ceiling throws, and the caller gets nothing back.
	it('costs one subrequest for each already-attested bundle of a page', async () => {
		const extra = 4;
		const first = await committedPathBundle();
		const { token } = first;
		await attachBundle(token, first.metadata.storePathHash, first.bundle);
		const bundles = [
			{ storePathHash: first.metadata.storePathHash, digest: first.digest }
		];

		for (let index = 0; index < extra; index += 1) {
			const nar = await verifiableNar(`attested-${String(index)}`);
			const metadata = uploadMetadata({
				storePathHash: uniqueStorePathHash(),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
			const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
			await attachBundle(token, metadata.storePathHash, bundle);
			bundles.push({
				storePathHash: metadata.storePathHash,
				digest: sha256HexDigestSchema.parse(await sha256HexBytes(bundle))
			});
		}

		const heads = vi.spyOn(env.BLOBS, 'head');

		try {
			const response = await authorisedWorkerFetch('/attestations', token, {
				body: JSON.stringify({ pushId: testPushId, bundles }),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});

			expect(response.status).toBe(StatusCodes.OK);

			const casHeads = heads.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cas/')
			).length;
			const pageHeads =
				(casHeads / bundles.length) * attestationNegotiateMaxBundles;

			expect({
				headsPerBundle: casHeads / bundles.length,
				pageFitsTheCeiling:
					pageHeads <= workersInvocationAllowances.free.subrequests
			}).toStrictEqual({ headsPerBundle: 1, pageFitsTheCeiling: true });
		} finally {
			heads.mockRestore();
		}
	});

	it('fits a maximum distinct-digest page through cold and warm request dispatch', async () => {
		const first = await committedPathBundle();
		const digests = Array.from(
			{ length: attestationNegotiateMaxBundles },
			(_, index) =>
				sha256HexDigestSchema.parse((index + 1).toString(16).padStart(64, '0'))
		);
		const database = drizzleD1(env.CUPBOARD_DB, {
			schema: { casObject: d1Schema.casObject }
		});

		for (const page of chunk(digests, 25)) {
			await database
				.insert(d1Schema.casObject)
				.values(
					page.map((digest) => ({
						digest,
						size: 1,
						storedAt: isoTimestamp(new Date())
					}))
				)
				.run();
		}

		const bundles = digests.map((digest) => ({
			storePathHash: first.metadata.storePathHash,
			digest
		}));
		const now = new Date();
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const expiresAt = isoTimestamp(new Date(now.getTime() + 15 * 60 * 1000));

		let result;

		try {
			result = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance, state) => {
					const restarted = new CupboardServer(state, {
						...instance.context.env,
						BLOBS: env.BLOBS,
						CUPBOARD_DB: env.CUPBOARD_DB,
						CUPBOARD_SUBREQUESTS_PER_INVOCATION: String(
							workersInvocationAllowances.free.subrequests
						)
					});

					const negotiate = () =>
						withSubrequestSlice(
							async () => {
								const availableBefore = subrequestsAvailable();
								const response = await restarted.fetch(
									new Request('https://cupboard.test/attestations', {
										body: JSON.stringify({ pushId: testPushId, bundles }),
										headers: {
											authorization: `Bearer ${first.token}`,
											'content-type': 'application/json'
										},
										method: 'POST'
									})
								);

								return {
									calls: availableBefore - subrequestsAvailable(),
									httpStatus: response.status,
									body: attestationNegotiateResponseSchema.parse(
										await response.json()
									)
								};
							},
							{
								subrequests: workersInvocationAllowances.free.subrequests,
								reserve: subrequestSafetyReserve
							}
						);

					const previousIds = new Set(
						restarted.context.db
							.select({ id: schema.pendingAttestations.id })
							.from(schema.pendingAttestations)
							.all()
							.map((row) => row.id)
					);
					const newUploadIds = () => {
						const rows = restarted.context.db
							.select({
								id: schema.pendingAttestations.id,
								digest: schema.pendingAttestations.digest
							})
							.from(schema.pendingAttestations)
							.all()
							.filter((row) => !previousIds.has(row.id));
						for (const row of rows) {
							previousIds.add(row.id);
						}
						const ids = new Map(rows.map((row) => [row.digest, row.id]));
						expect(
							rows.map((row) => row.digest).toSorted(byCodeUnit)
						).toStrictEqual([...digests].toSorted(byCodeUnit));
						return bundles.map((bundle) => ids.get(bundle.digest));
					};
					const cold = await negotiate();
					const coldUploadIds = newUploadIds();
					const warm = await negotiate();
					const warmUploadIds = newUploadIds();
					return { cold, warm, coldUploadIds, warmUploadIds };
				}
			);
		} finally {
			vi.useRealTimers();
		}

		const decisions = (uploadIds: typeof result.coldUploadIds) =>
			bundles.map((bundle, index) => {
				const uploadId = uploadIds[index];

				if (uploadId === undefined) {
					throw new Error('missing expected upload ID');
				}

				return {
					action: 'upload' as const,
					...bundle,
					uploadId,
					r2Key: attestationStagingObjectKey(testPushId, uploadId),
					expiresAt
				};
			});

		expect({ cold: result.cold, warm: result.warm }).toStrictEqual({
			cold: {
				calls: 855,
				httpStatus: StatusCodes.OK,
				body: {
					bundles: decisions(result.coldUploadIds)
				}
			},
			warm: {
				calls: 854,
				httpStatus: StatusCodes.OK,
				body: {
					bundles: decisions(result.warmUploadIds)
				}
			}
		});
	}, 120_000);

	it('decides correctly for more bundles than a statement could bind', async () => {
		// 101 distinct storePathHashes and the cache would be 102 parameters if
		// the read bound a value per hash, so this pins the Durable Object read
		// that negotiate makes from a bound list.
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);

		const uncommittedHashes = Array.from({ length: maxBoundParameters }, () =>
			uniqueStorePathHash()
		);
		const fakeDigest = sha256HexDigestSchema.parse('ab'.repeat(32));
		const bundles = [
			{ storePathHash: metadata.storePathHash, digest },
			...uncommittedHashes.map((storePathHash) => ({
				storePathHash,
				digest: fakeDigest
			}))
		];

		const response = await authorisedWorkerFetch('/attestations', token, {
			body: JSON.stringify({ pushId: testPushId, bundles }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		expect(response.status).toBe(StatusCodes.OK);
		const body = attestationNegotiateResponseSchema.parse(
			await response.json()
		);
		const decisions = body.bundles.map((b) =>
			attestationDecisionSchema.parse(b)
		);

		const skipDecisions = decisions.filter((d) => d.action === 'skip');
		const uploadDecisions = decisions.filter((d) => d.action === 'upload');

		expect({
			totalDecisions: decisions.length,
			skipCount: skipDecisions.length,
			uploadCount: uploadDecisions.length,
			skip: skipDecisions
		}).toStrictEqual({
			totalDecisions: maxBoundParameters + 1,
			skipCount: 1,
			uploadCount: maxBoundParameters,
			skip: [{ action: 'skip', storePathHash: metadata.storePathHash, digest }]
		});
	});
});

function attestationsFor(context: ServerContext): AttestationsService {
	return new AttestationsService(
		context,
		new CacheRegistrationService(context),
		new AttestationCasService(context),
		new NarInfoObjectsService(context)
	);
}

// Runs one drain of the inheritance queue, as the maintenance alarm does.
async function drainInheritance(): Promise<MaintenanceProgress> {
	const outcome = await runInDurableObject(fixtureWorkerServer(), (instance) =>
		attestationsFor(instance.context).drainInheritanceQueue(rootLogger())
	);

	return outcome.progress;
}

function deletionQueueFor(context: ServerContext): DeletionQueueService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	return new DeletionQueueService(
		context,
		attestationCas,
		attestationsFor(context),
		narInfoObjects
	);
}

async function deleteFixtureSource(
	storePathHash: ReturnType<typeof storePathHashSchema.parse>
) {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		deletionQueueFor(instance.context).deleteStorePath(
			defaultCacheScope,
			storePathHash,
			internalOrigin
		)
	);
}

// Publishes a path to the default cache with one bundle, then publishes it to a
// named destination cache. The destination's inheritance row stays queued.
async function reusedPathWithSourceBundle(
	name: string,
	access: CacheAccessMode = 'public',
	beforeDestinationCommit?: (
		storePathHash: ReturnType<typeof storePathHashSchema.parse>
	) => Promise<void>
): Promise<{
	readonly token: string;
	readonly destination: Extract<CacheScope, { kind: 'named' }>;
	readonly metadata: ReturnType<typeof uploadMetadata>;
	readonly digest: Sha256HexDigest;
}> {
	const destination = namedCache(name);
	const token = await initialiseViaWorker();
	await putWorkerTestCache(token, destination, access);
	const nar = await verifiableNar(name);
	const metadata = uploadMetadata({
		storePathHash: uniqueStorePathHash(),
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
	const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
	await attachBundle(token, metadata.storePathHash, bundle);
	await drainInheritance();
	await pushPathThroughTenant(
		fixtureTenant,
		token,
		metadata,
		nar,
		destination,
		beforeDestinationCommit === undefined
			? undefined
			: () => beforeDestinationCommit(metadata.storePathHash)
	);

	return { token, destination, metadata, digest };
}

// Makes a failed path due again without waiting for its retry delay.
async function makeQueuedInheritancesDue(): Promise<void> {
	await runInDurableObject(fixtureWorkerServer(), (instance) => {
		instance.context.db
			.update(schema.attestationInheritances)
			.set({ notBefore: isoTimestamp(new Date()) })
			.run();
	});
}

async function queuedInheritances(): Promise<
	{ readonly storePathHash: string; readonly attempts: number }[]
> {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		instance.context.db
			.select({
				storePathHash: schema.attestationInheritances.storePathHash,
				attempts: schema.attestationInheritances.attempts
			})
			.from(schema.attestationInheritances)
			.all()
	);
}

async function committedPathBundle(): Promise<{
	readonly token: string;
	readonly nar: Awaited<ReturnType<typeof verifiableNar>>;
	readonly metadata: ReturnType<typeof uploadMetadata>;
	readonly bundle: Uint8Array;
	readonly digest: Sha256HexDigest;
}> {
	const token = await initialiseViaWorker();
	const nar = await verifiableNar('attestation-path');
	const storePathHash = uniqueStorePathHash();
	const metadata = uploadMetadata({
		storePathHash,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
	const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));

	return { token, nar, metadata, bundle, digest };
}

// Distinct for 1,024 calls: the cursor's two low base-32 digits vary.
function uniqueStorePathHash(): string {
	const nixBase32 = '0123456789abcdfghijklmnpqrsvwxyz';
	const index = storePathHashCursor.next;
	storePathHashCursor.next += 1;

	const high = nixBase32[Math.floor(index / 32) % 32] ?? '0';
	const low = nixBase32[index % 32] ?? '0';

	return `${'0'.repeat(30)}${high}${low}`;
}

async function attachBundle(
	token: string,
	pathHash: string,
	bundle: Uint8Array,
	cache: CacheScope = defaultCacheScope
): Promise<unknown> {
	const response = await attachBundleResponse(token, pathHash, bundle, cache);
	expect(response.status).toBe(StatusCodes.OK);

	return attestationAttachResponseSchema.parse(await response.json());
}

async function attachBundleResponse(
	token: string,
	pathHash: string,
	bundle: Uint8Array,
	cache: CacheScope = defaultCacheScope
): Promise<Response> {
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
	const decision = attestationUploadDecisionSchema.parse(
		await negotiate(token, pathHash, digest, cache)
	);

	await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

	return authorisedWorkerFetch(
		cacheScopedPath(cache, `/attestations/${decision.uploadId}/attach`),
		token,
		{ method: 'POST' }
	);
}

async function negotiate(
	token: string,
	pathHash: string,
	digest: Sha256HexDigest,
	cache: CacheScope = defaultCacheScope
): Promise<AttestationDecision> {
	const response = await authorisedWorkerFetch(
		cacheScopedPath(cache, '/attestations'),
		token,
		{
			body: JSON.stringify({
				pushId: testPushId,
				bundles: [{ storePathHash: pathHash, digest }]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(response.status).toBe(StatusCodes.OK);
	const body = attestationNegotiateResponseSchema.parse(await response.json());
	const [bundle] = z.tuple([attestationDecisionSchema]).parse(body.bundles);

	return bundle;
}

async function negotiateTenant(
	tenant: string,
	token: string,
	pathHash: string,
	digest: Sha256HexDigest
): Promise<AttestationDecision> {
	const pushId = await testPushIdFor(tenant);
	const response = await tenantFetch(tenant, '/attestations', token, {
		body: JSON.stringify({
			pushId,
			bundles: [{ storePathHash: pathHash, digest }]
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});
	expect(response.status).toBe(StatusCodes.OK);
	const body = attestationNegotiateResponseSchema.parse(await response.json());
	const [bundle] = z.tuple([attestationDecisionSchema]).parse(body.bundles);

	return bundle;
}

async function pendingAttestationRowsFor(
	tenant: string
): Promise<{ id: string; r2Key: string; expiresAt: string }[]> {
	const rows = await runInDurableObject(
		testServerFor(tenant),
		(_instance, state) =>
			drizzle(state.storage, {
				schema: { pendingAttestations: schema.pendingAttestations }
			})
				.select({
					id: schema.pendingAttestations.id,
					r2Key: schema.pendingAttestations.r2Key,
					expiresAt: schema.pendingAttestations.expiresAt
				})
				.from(schema.pendingAttestations)
				.all()
	);

	return rows.toSorted(compareById);
}

async function pushPathThroughTenant(
	tenant: string,
	token: string,
	metadata: ReturnType<typeof uploadMetadata>,
	nar: Awaited<ReturnType<typeof verifiableNar>>,
	cache?: CacheScope,
	beforeCommit?: () => Promise<void>
): Promise<void> {
	const pushId = await testPushIdFor(tenant);
	const negotiated = await tenantFetch(
		tenant,
		cacheScopedPath(cache ?? { kind: 'default' }, '/uploads'),
		token,
		{
			body: JSON.stringify({
				pushId,
				paths: [uploadPathNegotiation(metadata)]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(negotiated.status).toBe(StatusCodes.OK);
	const body = uploadNegotiateResponseSchema.parse(await negotiated.json());
	const [decision] = z.tuple([uploadDecisionSchema]).parse(body.uploads);
	expect(decision.action).not.toBe('skip');
	if (decision.action === 'skip') {
		throw new Error('Expected an upload or commit decision');
	}

	if (decision.action === 'upload') {
		await putNarBytes(decision.r2Key, nar);
	}

	await beforeCommit?.();

	const committed = await commitUploadViaWorker(token, decision.uploadId, {
		tenant,
		...(cache !== undefined && { cache })
	});
	expect(committed.status).toBe('committed');
}

function tenantFetch(
	tenant: string,
	path: string,
	token: string,
	init: RequestInit
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);

	return handlerFetch(`/t/${tenant}${path}`, { ...init, headers });
}
