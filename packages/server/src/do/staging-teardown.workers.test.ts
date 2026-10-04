import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narObjectKey, requestOriginSchema } from '../http/http.ts';
import {
	authorisedFetch,
	bootstrap,
	currentServer,
	namedCache,
	narBytes,
	narHash,
	pushPath,
	resetTestServer,
	restartTestServers,
	uploadMetadata,
	useTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';
import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';
import { withSubrequestSlice } from './subrequest-slice.ts';

const scope = namedCache('builds');
const origin = requestOriginSchema.parse('https://cache.example');

afterEach(() => {
	vi.restoreAllMocks();
});

async function fixture(name: string, uploads: number) {
	await useTestServer(name);
	const { token } = await bootstrap({ caches: [{ scope }] });
	const cache = await runInDurableObject(
		currentServer(),
		async (instance, state) => {
			await state.storage.deleteAlarm();
			const cache = instance.context.cacheRepository.require(scope);
			if (uploads > 0) {
				state.storage.sql.exec(
					`WITH RECURSIVE sequence(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
			)
			INSERT INTO pending_upload(id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at)
			SELECT 'staged-' || n, ?, ?, 'staging/backlog/' || printf('%04d', n) || '.nar.zst', '{}', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
			FROM sequence`,
					uploads,
					cache.id,
					narHash
				);
			}
			return cache;
		}
	);
	return { token, cache };
}

async function snapshot(cacheId: number) {
	return runInDurableObject(currentServer(), async (instance, state) => ({
		pending: state.storage.sql
			.exec('SELECT id FROM pending_upload WHERE cache_id = ?', cacheId)
			.toArray().length,
		staging: state.storage.sql
			.exec('SELECT r2_key FROM staging_cleanup WHERE cache_id = ?', cacheId)
			.toArray().length,
		live: instance.context.cacheRepository.resolve(scope)?.id,
		marker:
			(await state.storage.get(`${teardownEntryPrefix}${String(cacheId)}`)) !==
			undefined
	}));
}

describe('staged cache teardown', () => {
	beforeEach(resetTestServer);
	it('queues a backlog in SQL and drains successive bounded R2 batches', async () => {
		const { token, cache } = await fixture('staging-teardown-backlog', 1001);
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO pending_attestation(id,cache_id,digest,r2_key,created_at,expires_at) VALUES ('bundle',?,'digest','staging/backlog/attestations/bundle','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')",
				cache.id
			);
			state.storage.sql.exec(
				"INSERT INTO pending_attestation_subject(upload_id,subject_name,nar_digest) VALUES ('bundle','app','digest')"
			);
		});
		await withoutAlarmArming(async () => {
			const deletions = vi.spyOn(env.BLOBS, 'delete');
			const removed = await authorisedFetch('/caches/builds', token, {
				method: 'DELETE'
			});
			expect({
				status: removed.status,
				deletions: deletions.mock.calls
			}).toStrictEqual({
				status: StatusCodes.OK,
				deletions: []
			});
			const queued = await snapshot(cache.id);
			await currentServer().resumeCacheTeardown();
			const first = await snapshot(cache.id);
			await currentServer().resumeCacheTeardown();
			const second = await snapshot(cache.id);
			const subjects = await runInDurableObject(
				currentServer(),
				(_instance, state) =>
					state.storage.sql
						.exec('SELECT * FROM pending_attestation_subject')
						.toArray()
			);
			expect({
				queued,
				first,
				second,
				subjects,
				batchSizes: deletions.mock.calls.map(([keys]) =>
					typeof keys === 'string' ? 1 : keys.length
				)
			}).toStrictEqual({
				queued: { pending: 0, staging: 1002, live: undefined, marker: true },
				first: { pending: 0, staging: 0, live: undefined, marker: false },
				second: { pending: 0, staging: 0, live: undefined, marker: false },
				subjects: [],
				batchSizes: [1000, 2]
			});
		});
	});

	it('retains failed deletion batches across an object restart', async () => {
		const { cache } = await fixture('staging-teardown-retry', 2);
		const failed = await withoutAlarmArming(async () => {
			await currentServer().runCacheTeardown(scope, origin);
			const error = new Error('R2 unavailable');
			const deletions = vi
				.spyOn(env.BLOBS, 'delete')
				.mockRejectedValueOnce(error);
			const message = await runInDurableObject(
				currentServer(),
				async (instance) => {
					try {
						await instance.resumeCacheTeardown();
						return;
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
				}
			);
			expect(message).toBe('R2 unavailable');
			deletions.mockRestore();
			return snapshot(cache.id);
		});
		await restartTestServers();
		await withoutAlarmArming(async () => {
			const initialised = await currentServer().fetch(
				new Request(`${origin}/pubkey`)
			);
			await initialised.arrayBuffer();
			await currentServer().resumeCacheTeardown();
			expect({ failed, retried: await snapshot(cache.id) }).toStrictEqual({
				failed: { pending: 0, staging: 2, live: undefined, marker: true },
				retried: { pending: 0, staging: 0, live: undefined, marker: false }
			});
		});
	});

	it.each([0, 1])(
		'recovers a teardown with %i pending uploads when its marker is missing',
		async (uploads) => {
			const { cache } = await fixture(
				`staging-teardown-marker-gap-${String(uploads)}`,
				uploads
			);
			const interrupted = await withoutAlarmArming(async () => {
				await currentServer().runCacheTeardown(scope, origin);
				await runInDurableObject(currentServer(), async (instance, state) => {
					await state.storage.delete(
						`${teardownEntryPrefix}${String(cache.id)}`
					);
					await new MaintenanceEligibilityService(instance.context).reconcile();
				});
				const eligible = await runInDurableObject(currentServer(), (instance) =>
					instance.context.d1
						.select({ wake: d1Schema.tenantMaintenanceEligibility.nextWakeAt })
						.from(d1Schema.tenantMaintenanceEligibility)
						.get()
				);
				return { eligible, missingMarker: await snapshot(cache.id) };
			});
			await restartTestServers();
			await withoutAlarmArming(async () => {
				const initialised = await currentServer().fetch(
					new Request(`${origin}/pubkey`)
				);
				await initialised.arrayBuffer();
				await currentServer().resumeCacheTeardown();
				expect({
					...interrupted,
					resumed: await snapshot(cache.id)
				}).toStrictEqual({
					eligible: { wake: '1970-01-01T00:00:00.000Z' },
					missingMarker: {
						pending: 0,
						staging: uploads,
						live: undefined,
						marker: false
					},
					resumed: { pending: 0, staging: 0, live: undefined, marker: false }
				});
			});
		}
	);

	it('recovers published-state cleanup when its marker is missing', async () => {
		const { token, cache } = await fixture(
			'staging-teardown-published-marker-gap',
			0
		);
		await withoutAlarmArming(async () => {
			await pushPath(
				token,
				uploadMetadata({ fileSize: narBytes.byteLength }),
				scope
			);
			await currentServer().runCacheTeardown(scope, origin);
			await runInDurableObject(currentServer(), async (_instance, state) => {
				await state.storage.delete(`${teardownEntryPrefix}${String(cache.id)}`);
			});
			await currentServer().resumeCacheTeardown();
			expect(
				await runInDurableObject(currentServer(), (_instance, state) => ({
					headers: state.storage.sql
						.exec('SELECT * FROM cache_teardown')
						.toArray(),
					published: state.storage.sql
						.exec('SELECT * FROM narinfo_deletion WHERE cache_id = ?', cache.id)
						.toArray()
				}))
			).toStrictEqual({ headers: [], published: [] });
		});
	});

	it('defers an R2 batch when the pass has no subrequest budget', async () => {
		const { cache } = await fixture('staging-teardown-budget', 1);
		await withoutAlarmArming(async () => {
			await currentServer().runCacheTeardown(scope, origin);
			const deletions = vi.spyOn(env.BLOBS, 'delete');
			await runInDurableObject(currentServer(), (instance) =>
				withSubrequestSlice(() => instance.resumeCacheTeardown(), {
					subrequests: 3,
					reserve: 0
				})
			);
			expect({
				state: await snapshot(cache.id),
				deletions: deletions.mock.calls
			}).toStrictEqual({
				state: { pending: 0, staging: 1, live: undefined, marker: true },
				deletions: []
			});
			await currentServer().resumeCacheTeardown();
			expect(await snapshot(cache.id)).toStrictEqual({
				pending: 0,
				staging: 0,
				live: undefined,
				marker: false
			});
		});
	});

	it('uses a tight budget for one page and resumes the remaining page', async () => {
		const { cache } = await fixture('staging-teardown-tight-budget', 1001);
		await withoutAlarmArming(async () => {
			await currentServer().runCacheTeardown(scope, origin);
			const deletions = vi.spyOn(env.BLOBS, 'delete');
			await runInDurableObject(currentServer(), (instance) =>
				withSubrequestSlice(() => instance.resumeCacheTeardown(), {
					subrequests: 6,
					reserve: 0
				})
			);
			const first = await snapshot(cache.id);
			await currentServer().resumeCacheTeardown();
			expect({
				first,
				resumed: await snapshot(cache.id),
				batchSizes: deletions.mock.calls.map(([keys]) =>
					typeof keys === 'string' ? 1 : keys.length
				)
			}).toStrictEqual({
				first: { pending: 0, staging: 1, live: undefined, marker: true },
				resumed: { pending: 0, staging: 0, live: undefined, marker: false },
				batchSizes: [1000, 1]
			});
		});
	});

	it('preserves canonical objects and pending uploads in a new cache with the same name', async () => {
		const { token, cache } = await fixture('staging-teardown-new-identity', 1);
		const canonical = narObjectKey(narHash);
		const laterCanonical = narObjectKey(narHash, 2);
		const newStaging = 'staging/new-identity/upload.nar.zst';
		await env.BLOBS.put(canonical, new Uint8Array([1]));
		await env.BLOBS.put(laterCanonical, new Uint8Array([2]));
		await env.BLOBS.put(newStaging, new Uint8Array([3]));
		await runInDurableObject(currentServer(), (_instance, state) => {
			for (const [index, key] of [canonical, laterCanonical].entries()) {
				state.storage.sql.exec(
					"INSERT INTO pending_upload(id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at) VALUES (?, ?, ?, ?, '{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')",
					`canonical-${String(index)}`,
					cache.id,
					narHash,
					key
				);
			}
		});
		await withoutAlarmArming(async () => {
			await currentServer().runCacheTeardown(scope, origin);
			await authorisedFetch('/caches/builds', token, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public', priority: 40 })
			});
			const newCache = await runInDurableObject(
				currentServer(),
				(instance, state) => {
					const replacement = instance.context.cacheRepository.require(scope);
					state.storage.sql.exec(
						"INSERT INTO pending_upload(id,cache_id,nar_hash,r2_key,metadata_json,created_at,expires_at) VALUES ('replacement', ?, ?, ?, '{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')",
						replacement.id,
						narHash,
						newStaging
					);
					return replacement;
				}
			);
			const queued = await snapshot(cache.id);
			await currentServer().resumeCacheTeardown();
			expect({
				queued,
				old: await snapshot(cache.id),
				replacement: await snapshot(newCache.id),
				objects: await Promise.all(
					[canonical, laterCanonical, newStaging].map(
						async (key) => (await env.BLOBS.head(key)) !== null
					)
				)
			}).toStrictEqual({
				queued: { pending: 0, staging: 1, live: newCache.id, marker: true },
				old: { pending: 0, staging: 0, live: newCache.id, marker: false },
				replacement: {
					pending: 1,
					staging: 0,
					live: newCache.id,
					marker: false
				},
				objects: [true, true, true]
			});
		});
	});
});
