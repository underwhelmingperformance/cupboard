import type { CacheScope } from '@cupboard/nix-store/scalars';
import { uploadNegotiateResponseSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	commitUpload,
	currentServer,
	defaultCache,
	initialise,
	migrateThroughConvertedCatalogue,
	namedCache,
	narBytes,
	negotiateUploads,
	putNarBytes,
	readFetch,
	resetTestServer,
	singleDecision,
	testBase,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	withoutAlarmArming
} from '../test-support.ts';

import { CacheClosureService } from './cache-closure-service.ts';

const cache = namedCache('pr-1');

async function createCache(): Promise<string> {
	const token = await initialise();
	await runInDurableObject(currentServer(), async (_instance, state) => {
		await migrateThroughConvertedCatalogue(state);
	});
	const response = await authorisedFetch('/caches/pr-1', token, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			access: 'public',
			priority: 30,
			defaultRootRetention: { kind: 'duration', seconds: 3600 },
			grace: { kind: 'duration', graceSeconds: 60 }
		})
	});
	expect(response.status).toBe(StatusCodes.OK);
	return token;
}

async function lifecycle(
	token: string,
	action: 'close' | 'reopen'
): Promise<void> {
	const response = await authorisedFetch(`/caches/pr-1/${action}`, token, {
		method: 'POST'
	});
	expect(response.status, await response.clone().text()).toBe(StatusCodes.OK);
}

async function negotiate(
	token: string,
	metadata = uploadMetadata({ fileSize: narBytes.byteLength, references: [] })
) {
	const response = await authorisedFetch('/cache/pr-1/uploads', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			pushId: testPushId,
			paths: [uploadPathNegotiation(metadata)],
			attachRoot: { name: 'ci/run', retention: { kind: 'inherit' } }
		})
	});
	expect(response.status, await response.clone().text()).toBe(StatusCodes.OK);
	return singleDecision(
		uploadNegotiateResponseSchema.parse(await response.json())
	);
}

async function roots(token: string): Promise<unknown> {
	const response = await authorisedFetch('/cache/pr-1/roots', token);
	expect(response.status).toBe(StatusCodes.OK);
	return response.json();
}

async function renew(token: string): Promise<void> {
	const response = await authorisedFetch('/cache/pr-1/roots/ci%2Frun', token, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			targets: [],
			retention: { kind: 'duration', seconds: 3600 }
		})
	});
	expect(response.status).toBe(StatusCodes.OK);
}

describe('cache close', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			path: '/caches/pr-1',
			method: 'PATCH',
			body: {
				kind: 'set-default-root-ttl',
				retention: { kind: 'duration', seconds: 3600 }
			}
		},
		{
			path: '/cache',
			method: 'PATCH',
			body: {
				kind: 'set-default-root-ttl',
				retention: { kind: 'duration', seconds: 3600 }
			}
		},
		{
			path: '/caches/pr-1/retirement',
			method: 'PUT',
			body: { retireWhenEmpty: true }
		}
	])(
		'returns a defined closed-cache conflict for $method $path',
		async ({ path, method, body }) => {
			const token = await createCache();
			const scope: CacheScope = path === '/cache' ? { kind: 'default' } : cache;
			await (scope.kind === 'named'
				? lifecycle(token, 'close')
				: runInDurableObject(currentServer(), (instance, state) => {
						const resolved = instance.context.cacheRepository.require(scope);
						state.storage.sql.exec(
							"INSERT INTO managed_cache_retirement(cache_id,eligible_after,retirement_started_at) VALUES (?, '2099-01-01T00:00:00.000Z', ?)",
							resolved.id,
							testBase.toISOString()
						);
					}));
			const response = await authorisedFetch(path, token, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			expect({
				status: response.status,
				body: await response.json()
			}).toStrictEqual({
				status: StatusCodes.CONFLICT,
				body: {
					defined: true,
					code: 'CACHE_CLOSED',
					status: StatusCodes.CONFLICT,
					message:
						'This cache is closed. Reopen the cache before publishing or extending retention.',
					data: { cache: scope }
				}
			});
		}
	);

	it('repeats close without changing its expiry, generation or read authority', async () => {
		const token = await createCache();
		const decision = await negotiate(token);
		if (decision.action === 'skip') {
			throw new Error('Expected a new upload');
		}
		if (decision.action === 'upload') {
			await putNarBytes(decision.r2Key);
		}
		await commitUpload(token, decision.uploadId, cache);
		const generation = await runInDurableObject(
			currentServer(),
			(instance) => instance.context.cacheRepository.require(cache).generation
		);
		await lifecycle(token, 'close');
		vi.setSystemTime(new Date(testBase.getTime() + 30_000));
		await lifecycle(token, 'close');
		const listed = await roots(token);
		expect(listed).toMatchObject({
			roots: [
				{ name: 'ci/run', expiresAt: testBase.toISOString(), expired: true }
			]
		});
		const read = await readFetch(
			`/cache/pr-1/${uploadMetadata({ fileSize: narBytes.byteLength, references: [] }).storePathHash}.narinfo`
		);
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			references: []
		});
		const write = await authorisedFetch('/cache/pr-1/uploads', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		});
		expect({
			read: read.status,
			write: { status: write.status, body: await write.json() },
			generation: await runInDurableObject(
				currentServer(),
				(instance) => instance.context.cacheRepository.require(cache).generation
			)
		}).toStrictEqual({
			read: StatusCodes.OK,
			write: {
				status: StatusCodes.CONFLICT,
				body: {
					defined: true,
					code: 'CACHE_CLOSED',
					status: StatusCodes.CONFLICT,
					message:
						'This cache is closed. Reopen the cache before publishing or extending retention.',
					data: { cache: { kind: 'named', name: 'pr-1' } }
				}
			},
			generation
		});
	});

	it('keeps old expiry after reopen but permits an explicit renewal', async () => {
		const token = await createCache();
		await renew(token);
		await lifecycle(token, 'close');
		await lifecycle(token, 'reopen');
		expect(await roots(token)).toMatchObject({
			roots: [{ expiresAt: testBase.toISOString(), expired: true }]
		});
		vi.setSystemTime(new Date(testBase.getTime() + 10_000));
		await renew(token);
		expect(await roots(token)).toMatchObject({
			roots: [{ expiresAt: '2026-01-01T01:00:10.000Z', expired: false }]
		});
		await lifecycle(token, 'close');
		expect(await roots(token)).toMatchObject({
			roots: [{ expiresAt: '2026-01-01T00:00:10.000Z', expired: true }]
		});
	});

	it('gives a pre-close upload the original grace without attaching to a renewed root', async () => {
		const token = await createCache();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			references: []
		});
		const decision = await negotiate(token, metadata);
		if (decision.action === 'skip') {
			throw new Error('Expected a new upload');
		}
		if (decision.action === 'upload') {
			await putNarBytes(decision.r2Key);
		}
		await lifecycle(token, 'close');
		await lifecycle(token, 'reopen');
		vi.setSystemTime(new Date(testBase.getTime() + 30_000));
		await renew(token);
		await commitUpload(token, decision.uploadId, cache);
		expect(await roots(token)).toMatchObject({
			roots: [{ expiresAt: '2026-01-01T01:00:30.000Z', targetCount: 0 }]
		});
		const retained = await runInDurableObject(
			currentServer(),
			(_instance, state) => ({
				grace: state.storage.sql
					.exec('SELECT retain_until FROM retention_grace')
					.toArray(),
				epochs: state.storage.sql
					.exec('SELECT retention_epoch FROM narinfo')
					.toArray()
			})
		);
		expect(retained).toStrictEqual({
			grace: [{ retain_until: '2026-01-01T00:01:00.000Z' }],
			epochs: [{ retention_epoch: 0 }]
		});
	});

	it.each([false, true])(
		'applies the admission epoch when exhausted cleanup finds a committed upload: reopened admission %s',
		async (reopenedAdmission) => {
			const token = await createCache();
			if (reopenedAdmission) {
				await lifecycle(token, 'close');
				await lifecycle(token, 'reopen');
			}
			const decision = await negotiate(token);
			if (decision.action === 'skip') {
				throw new Error('Expected a new upload');
			}
			const pending = await runInDurableObject(currentServer(), (instance) =>
				instance.context.db
					.select()
					.from(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, decision.uploadId))
					.get()
			);
			if (pending === undefined) {
				throw new Error('The fixture needs its admitted upload.');
			}
			if (decision.action === 'upload') {
				await putNarBytes(decision.r2Key);
			}
			await commitUpload(token, decision.uploadId, cache);
			if (!reopenedAdmission) {
				await lifecycle(token, 'close');
				await lifecycle(token, 'reopen');
			}
			vi.setSystemTime(new Date(testBase.getTime() + 30_000));
			await renew(token);
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db.delete(schema.retentionRootTargets).run();
				instance.context.db
					.insert(schema.pendingUploads)
					.values({
						...pending,
						verdict: 'pending',
						claimOwner: sql`null`,
						claimedAt: sql`null`,
						settleFailures: 12,
						settleExhaustion: 'attempt-limit',
						settleRetryAfter: sql`null`
					})
					.run();
			});
			await withoutAlarmArming(() =>
				currentServer().recordVerifications('cleanup-owner', [])
			);
			const result = await runInDurableObject(
				currentServer(),
				(_instance, state) => ({
					roots: state.storage.sql
						.exec(
							'SELECT retention_epoch, expires_at, (SELECT count(*) FROM retention_root_target) AS targets FROM retention_root'
						)
						.toArray(),
					pending: state.storage.sql
						.exec('SELECT id FROM pending_upload')
						.toArray()
				})
			);
			expect(result).toStrictEqual({
				roots: [
					{
						retention_epoch: 1,
						expires_at: '2026-01-01T01:00:30.000Z',
						targets: reopenedAdmission ? 1 : 0
					}
				],
				pending: []
			});
		}
	);

	it.each(['remove', 'replace', 'collect'])(
		'does not recreate grace for a deleted path after close: %s',
		async (operation) => {
			const token = await createCache();
			await withoutAlarmArming(async () => {
				const metadata = uploadMetadata({
					fileSize: narBytes.byteLength,
					references: []
				});
				const decision = await negotiate(token, metadata);
				if (decision.action === 'skip') {
					throw new Error('Expected a new upload');
				}
				if (decision.action === 'upload') {
					await putNarBytes(decision.r2Key);
				}
				await commitUpload(token, decision.uploadId, cache);
				const deleted = await authorisedFetch(
					`/cache/pr-1/paths/${metadata.storePathHash}`,
					token,
					{ method: 'DELETE' }
				);
				expect(deleted.status, await deleted.clone().text()).toBe(
					StatusCodes.OK
				);
				await lifecycle(token, 'close');

				switch (operation) {
					case 'replace': {
						await lifecycle(token, 'reopen');
						await renew(token);
						break;
					}
					case 'remove': {
						const removed = await authorisedFetch(
							'/cache/pr-1/roots/ci%2Frun',
							token,
							{ method: 'DELETE' }
						);
						expect(removed.status).toBe(StatusCodes.OK);
						break;
					}
					case 'collect': {
						const collected = await authorisedFetch('/cache/pr-1/gc', token, {
							method: 'POST'
						});
						expect(collected.status).toBe(StatusCodes.OK);
						break;
					}
				}

				const result = await runInDurableObject(
					currentServer(),
					(_instance, state) => ({
						narinfos: state.storage.sql
							.exec('SELECT store_path_hash FROM narinfo')
							.toArray(),
						grace: state.storage.sql
							.exec('SELECT store_path_hash, retain_until FROM retention_grace')
							.toArray()
					})
				);
				expect(result).toStrictEqual({ narinfos: [], grace: [] });
			});
		}
	);

	it.each([
		{ operation: 'remove', elapsedMs: 30_000, releaseBeforePublication: true },
		...['remove', 'replace', 'collect'].flatMap((operation) =>
			[0, 30_000].map((elapsedMs) => ({
				operation,
				elapsedMs,
				releaseBeforePublication: false
			}))
		)
	])(
		'does not retain a zero-grace publication with an old close deadline: $operation, elapsed $elapsedMs, released first $releaseBeforePublication',
		async ({ operation, elapsedMs, releaseBeforePublication }) => {
			const token = await createCache();
			await withoutAlarmArming(async () => {
				const metadata = uploadMetadata({
					fileSize: narBytes.byteLength,
					references: []
				});
				const decision = await negotiate(token, metadata);
				if (decision.action === 'skip') {
					throw new Error('Expected a new upload');
				}
				if (decision.action === 'upload') {
					await putNarBytes(decision.r2Key);
				}
				await commitUpload(token, decision.uploadId, cache);
				const deleted = await authorisedFetch(
					`/cache/pr-1/paths/${metadata.storePathHash}`,
					token,
					{ method: 'DELETE' }
				);
				expect(deleted.status).toBe(StatusCodes.OK);
				await lifecycle(token, 'close');
				const release = async () => {
					if (operation === 'replace') {
						await renew(token);
						return;
					}
					const removed = await authorisedFetch(
						operation === 'collect'
							? '/cache/pr-1/gc'
							: '/cache/pr-1/roots/ci%2Frun',
						token,
						{ method: operation === 'collect' ? 'POST' : 'DELETE' }
					);
					expect(removed.status).toBe(StatusCodes.OK);
				};
				if (releaseBeforePublication) {
					await release();
				}
				await lifecycle(token, 'reopen');
				const configured = await authorisedFetch('/caches/pr-1', token, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: 'set-grace', graceSeconds: 0 })
				});
				expect(configured.status).toBe(StatusCodes.OK);
				vi.setSystemTime(new Date(testBase.getTime() + elapsedMs));
				const response = await authorisedFetch('/cache/pr-1/uploads', token, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						pushId: testPushId,
						paths: [uploadPathNegotiation(metadata)]
					})
				});
				expect(response.status, await response.clone().text()).toBe(
					StatusCodes.OK
				);
				const next = singleDecision(
					uploadNegotiateResponseSchema.parse(await response.json())
				);
				if (next.action === 'skip') {
					throw new Error('Expected a new publication');
				}
				if (next.action === 'upload') {
					await putNarBytes(next.r2Key);
				}
				await commitUpload(token, next.uploadId, cache);
				if (!releaseBeforePublication) {
					await release();
				}
				const published = await runInDurableObject(
					currentServer(),
					(_instance, state) => ({
						grace: state.storage.sql
							.exec('SELECT retain_until FROM retention_grace')
							.toArray(),
						roots: state.storage.sql
							.exec('SELECT name FROM retention_root')
							.toArray(),
						narinfos: state.storage.sql
							.exec('SELECT store_path_hash FROM narinfo')
							.toArray()
					})
				);
				const collected = await authorisedFetch('/cache/pr-1/gc', token, {
					method: 'POST'
				});
				expect(collected.status).toBe(StatusCodes.OK);
				const read = await readFetch(
					`/cache/pr-1/${metadata.storePathHash}.narinfo`
				);
				expect({ published, readStatus: read.status }).toStrictEqual({
					published: {
						grace: [],
						roots: operation === 'replace' ? [{ name: 'ci/run' }] : [],
						narinfos:
							operation === 'collect'
								? []
								: [{ store_path_hash: metadata.storePathHash }]
					},
					readStatus: StatusCodes.NOT_FOUND
				});
			});
		}
	);

	it.each([false, true])(
		'preserves the destination admission epoch when reusing a verified source: legacy grace decision %s',
		async (legacyGraceDecision) => {
			const token = await createCache();
			await withoutAlarmArming(async () => {
				const metadata = uploadMetadata({
					fileSize: narBytes.byteLength,
					references: []
				});
				const source = singleDecision(
					await negotiateUploads(token, [metadata], defaultCache())
				);
				if (source.action !== 'upload') {
					throw new Error('Expected the source cache to upload new bytes');
				}
				await putNarBytes(source.r2Key);
				await commitUpload(token, source.uploadId, defaultCache());
				await lifecycle(token, 'close');
				await lifecycle(token, 'reopen');
				const destination = await negotiate(token, metadata);
				if (destination.action !== 'commit') {
					throw new Error(
						'Expected the destination to reuse the verified source'
					);
				}
				if (legacyGraceDecision) {
					await runInDurableObject(currentServer(), (instance) => {
						instance.context.db
							.update(schema.pendingUploads)
							.set({
								graceDecisionJson: sql`json_remove(${schema.pendingUploads.graceDecisionJson}, '$.retentionEpoch')`
							})
							.where(eq(schema.pendingUploads.id, destination.uploadId))
							.run();
					});
				}
				await commitUpload(token, destination.uploadId, cache);
				await lifecycle(token, 'close');
				await lifecycle(token, 'reopen');
				const replay = await negotiate(token, metadata);
				if (replay.action !== 'skip') {
					throw new Error('Expected the existing publication to be skipped');
				}
				const stored = await runInDurableObject(currentServer(), (instance) =>
					instance.context.db
						.select({
							cacheId: schema.narInfos.cacheId,
							retentionEpoch: schema.narInfos.retentionEpoch
						})
						.from(schema.narInfos)
						.all()
						.map((row) => ({
							cache: instance.context.cacheRepository.scopeForId(row.cacheId),
							retentionEpoch: row.retentionEpoch
						}))
				);
				expect(stored).toStrictEqual([
					{ cache: defaultCache(), retentionEpoch: 0 },
					{ cache, retentionEpoch: 1 }
				]);
			});
		}
	);

	it('preserves an existing later grace deadline when closed roots expire', async () => {
		const token = await createCache();
		const decision = await negotiate(token);
		if (decision.action === 'skip') {
			throw new Error('Expected a new upload');
		}
		if (decision.action === 'upload') {
			await putNarBytes(decision.r2Key);
		}
		await commitUpload(token, decision.uploadId, cache);
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE retention_grace SET retain_until = '2026-01-01T00:05:00.000Z'"
			);
		});
		await lifecycle(token, 'close');
		await withoutAlarmArming(() => currentServer().runGarbageCollection());
		const deadlines = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				state.storage.sql
					.exec('SELECT retain_until FROM retention_grace')
					.toArray()
		);
		expect(deadlines).toStrictEqual([
			{ retain_until: '2026-01-01T00:05:00.000Z' }
		]);
	});

	it('collects closed contents after grace and retires only after pending work drains', async () => {
		let token = await createCache();
		const decision = await negotiate(token);
		if (decision.action === 'skip') {
			throw new Error('Expected a new upload');
		}
		if (decision.action === 'upload') {
			await putNarBytes(decision.r2Key);
		}
		await commitUpload(token, decision.uploadId, cache);
		await runInDurableObject(currentServer(), (instance, state) => {
			const cacheId = instance.context.cacheRepository.require(cache).id;
			state.storage.sql.exec(
				'INSERT INTO pending_attestation(id, cache_id, digest, r2_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
				'pending-close',
				cacheId,
				'a'.repeat(64),
				'staging/pending-close',
				testBase.toISOString(),
				'2026-01-01T00:15:00.000Z'
			);
		});
		await lifecycle(token, 'close');
		await withoutAlarmArming(() => currentServer().runGarbageCollection());
		const duringGrace = await readFetch(
			`/cache/pr-1/${uploadMetadata({ fileSize: narBytes.byteLength, references: [] }).storePathHash}.narinfo`
		);
		expect(duringGrace.status).toBe(StatusCodes.OK);
		vi.setSystemTime(new Date(testBase.getTime() + 61_000));
		await withoutAlarmArming(async () => {
			for (let pass = 0; pass < 8; pass += 1) {
				await currentServer().runGarbageCollection();
				await runInDurableObject(currentServer(), (instance) =>
					instance.alarm()
				);
			}
		});
		const waiting = await authorisedFetch('/caches/pr-1', token);
		expect(waiting.status).toBe(StatusCodes.OK);
		vi.setSystemTime(new Date(testBase.getTime() + 16 * 60_000));
		token = await initialise();
		await withoutAlarmArming(async () => {
			for (let pass = 0; pass < 8; pass += 1) {
				await currentServer().runGarbageCollection();
				await runInDurableObject(currentServer(), (instance) =>
					instance.alarm()
				);
			}
		});
		const retired = await authorisedFetch('/caches/pr-1', token);
		expect(retired.status).toBe(StatusCodes.NOT_FOUND);
		const replay = await authorisedFetch('/caches/pr-1/close', token, {
			method: 'POST'
		});
		expect({ status: replay.status, body: await replay.json() }).toStrictEqual({
			status: StatusCodes.OK,
			body: { scope: { kind: 'named', name: 'pr-1' }, closed: false }
		});
		const reopened = await authorisedFetch('/caches/pr-1/reopen', token, {
			method: 'POST'
		});
		expect(reopened.status).toBe(StatusCodes.NOT_FOUND);
		const missing = await authorisedFetch('/caches/pr-1', token);
		expect(missing.status).toBe(StatusCodes.NOT_FOUND);
	});
	it('bounds close and lazy expiry costs independently of the root backlog', async () => {
		const costs = [];
		for (const count of [3, 200]) {
			await resetTestServer();
			const token = await createCache();
			await runInDurableObject(currentServer(), (instance, state) => {
				const cacheId = instance.context.cacheRepository.require(cache).id;
				for (let index = 0; index < count; index += 1) {
					state.storage.sql.exec(
						'INSERT INTO retention_root(cache_id, name, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
						cacheId,
						`run-${String(index)}`,
						'2099-01-01T00:00:00.000Z',
						testBase.toISOString(),
						testBase.toISOString()
					);
				}
			});
			const cost = await runInDurableObject(
				currentServer(),
				async (instance) => {
					instance.context.dbCost.recordOutstanding();
					const before = instance.context.dbCost.rowsRead;
					const response = await instance.fetch(
						new Request('https://cache.test/caches/pr-1/close', {
							method: 'POST',
							headers: { authorization: `Bearer ${token}` }
						})
					);
					expect(response.status).toBe(StatusCodes.OK);
					instance.context.dbCost.recordOutstanding();
					const close = instance.context.dbCost.rowsRead - before;
					const closure = new CacheClosureService(instance.context);
					const materialiseBefore = instance.context.dbCost.rowsRead;
					expect(
						closure.materialiseRoots(
							instance.context.cacheRepository.require(cache),
							2
						)
					).toBe(true);
					instance.context.dbCost.recordOutstanding();
					return {
						close,
						materialise: instance.context.dbCost.rowsRead - materialiseBefore
					};
				}
			);
			costs.push(cost);
		}
		expect(costs[1]).toStrictEqual(costs[0]);
	});

	it('cleans history in bounded pages while keeping an old pending upload anchor', async () => {
		const token = await createCache();
		await negotiate(token);
		await lifecycle(token, 'close');
		await lifecycle(token, 'reopen');
		await runInDurableObject(currentServer(), (instance, state) => {
			const resolved = instance.context.cacheRepository.require(cache);
			for (let epoch = 2; epoch <= 8; epoch += 1) {
				state.storage.sql.exec(
					'INSERT INTO cache_close_event(cache_id, epoch, closed_at, grace_until) VALUES (?, ?, ?, ?)',
					resolved.id,
					epoch,
					'2026-01-01T00:00:30.000Z',
					'2026-01-01T00:01:30.000Z'
				);
			}
			const closure = new CacheClosureService(instance.context);
			expect(closure.cleanHistory(resolved, 2)).toBe(true);
			expect(
				state.storage.sql
					.exec('SELECT epoch FROM cache_close_event ORDER BY epoch')
					.toArray()
			).toStrictEqual([1, 3, 4, 5, 6, 7, 8].map((epoch) => ({ epoch })));
			for (let pass = 0; pass < 5; pass += 1) {
				closure.cleanHistory(resolved, 2);
			}
			expect(
				state.storage.sql
					.exec('SELECT epoch FROM cache_close_event ORDER BY epoch')
					.toArray()
			).toStrictEqual([{ epoch: 1 }]);
			expect(closure.firstClose(resolved, 0)).toMatchObject({
				closedAt: testBase.toISOString(),
				graceUntil: '2026-01-01T00:01:00.000Z'
			});
		});
	});
});
