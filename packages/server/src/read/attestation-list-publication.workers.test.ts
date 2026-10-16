import {
	narInfoGenerationSchema,
	predicateTypeSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AttestationListRevisionRepository } from '../db/attestation-list-revision.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { AttestationListRefreshService } from '../do/attestation-list-refresh-service.ts';
import { committedPath } from '../do/reuse-view-read.test-support.ts';
import { attestationListObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	defaultCache,
	fixtureWorkerServer,
	readFetch,
	resetTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import { authorisedNarInfoVersions } from './read.ts';

const digest = sha256HexDigestSchema.parse('a'.repeat(64));
const predicate = predicateTypeSchema.parse('https://example.org/list-read');
const descriptor = { digest, predicateType: predicate, size: 64 };

async function activate() {
	await env.CUPBOARD_DB.prepare(
		"INSERT INTO deployment_transition (id, state, updated_at) VALUES ('attestation-list-revision', 'complete', '2026-10-12T00:00:00.000Z')"
	).run();
}

async function publication() {
	const path = await committedPath('versioned-list-read', defaultCache());
	const hash = storePathHashSchema.parse(path.storePathHash);
	const versions = await authorisedNarInfoVersions(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		fixtureTenant,
		defaultCache(),
		[hash]
	);
	const parent = versions.get(hash);
	if (parent === undefined) {
		throw new Error('The NAR was not published');
	}
	await env.CUPBOARD_DB.batch([
		env.CUPBOARD_DB.prepare(
			"INSERT INTO cas_object_storage (digest, size, incarnation, stored_at) VALUES (?, 64, 1, '2026-10-12T00:00:00.000Z')"
		).bind(digest),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO attestation_ref_storage (tenant, cache_kind, cache_name, store_path_hash, generation, predicate_type, digest) VALUES (?, 'default', NULL, ?, ?, ?, ?)"
		).bind(
			fixtureTenant,
			hash,
			narInfoGenerationSchema.parse(parent.generation),
			predicate,
			digest
		)
	]);
	await env.BLOBS.put(
		attestationListObjectKey(fixtureTenant, hash, defaultCache()),
		JSON.stringify({ attestations: [{ ...descriptor, size: 4096 }] }),
		{ customMetadata: { 'narinfo-generation': String(parent.generation) } }
	);
	return { hash, parent };
}

async function requestList(
	hash: string,
	surface: 'raw' | 'discovery',
	method = 'GET'
) {
	return surface === 'raw'
		? readFetch(`/attestations/${hash}`, { method })
		: readFetch('/api/v1/attestation-info', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ storePathHashes: [hash] })
			});
}

async function refresh() {
	await runInDurableObject(fixtureWorkerServer(), async (instance) => {
		for (let pass = 0; pass < 12; pass++) {
			await new AttestationListRefreshService(instance.context).advance();
		}
	});
}

describe('revision-aware list reads', () => {
	beforeEach(resetTestServer);

	it.each(['raw', 'discovery'] as const)(
		'retains legacy %s reads before activation',
		async (surface) =>
			withoutAlarmArming(async () => {
				const { hash } = await publication();
				const response = await requestList(hash, surface);
				expect(response.status).toBe(200);
			}, fixtureWorkerServer())
	);

	it.each(['raw', 'discovery'] as const)(
		'refuses a pending %s list without serving the legacy body',
		async (surface) =>
			withoutAlarmArming(async () => {
				const { hash } = await publication();
				await activate();
				const response = await requestList(hash, surface);
				expect({
					status: response.status,
					retryAfter: response.headers.get('retry-after'),
					cacheControl: response.headers.get('cache-control'),
					body: await response.json()
				}).toStrictEqual({
					status: 503,
					retryAfter: '5',
					cacheControl: 'no-store',
					body: {
						code: 'list-pending',
						message: 'Attestation list refresh is pending. Retry the request.',
						storePathHash: hash
					}
				});
			}, fixtureWorkerServer())
	);

	it.each(['raw', 'discovery'] as const)(
		'serves the immutable %s list after refresh and refuses it after invalidation',
		async (surface) =>
			withoutAlarmArming(async () => {
				const { hash, parent } = await publication();
				await activate();
				await refresh();
				const ready = await requestList(hash, surface);
				expect({
					status: ready.status,
					body: await ready.json()
				}).toStrictEqual({
					status: 200,
					body:
						surface === 'raw'
							? { attestations: [descriptor] }
							: {
									scopeVersion: 'cache:1:1:public:false',
									entries: [
										{
											storePathHash: hash,
											status: 'found',
											narHash: parent.narHash,
											attestations: [descriptor]
										}
									]
								}
				});
				await env.CUPBOARD_DB.prepare(
					'UPDATE attestation_ref_storage SET readable = 0 WHERE tenant = ? AND store_path_hash = ?'
				)
					.bind(fixtureTenant, hash)
					.run();
				const pending = await requestList(hash, surface);
				expect(pending.status).toBe(503);
			}, fixtureWorkerServer())
	);

	it('refuses a current NAR with no revision after activation', async () =>
		withoutAlarmArming(async () => {
			const { hash } = await publication();
			await env.CUPBOARD_DB.prepare(
				'DELETE FROM attestation_list_revision WHERE tenant = ? AND store_path_hash = ?'
			)
				.bind(fixtureTenant, hash)
				.run();
			await activate();
			const response = await requestList(hash, 'discovery');
			expect(response.status).toBe(503);
		}, fixtureWorkerServer()));
	it('revalidates a buffered discovery response after reference invalidation during R2 retrieval', async () =>
		withoutAlarmArming(async () => {
			const { hash } = await publication();
			await activate();
			await refresh();
			const original = env.BLOBS.get.bind(env.BLOBS);
			const get = vi
				.spyOn(env.BLOBS, 'get')
				.mockImplementationOnce(async (key, options) => {
					const object = await original(key, options);
					await env.CUPBOARD_DB.prepare(
						'UPDATE attestation_ref_storage SET readable = 0 WHERE tenant = ? AND store_path_hash = ?'
					)
						.bind(fixtureTenant, hash)
						.run();
					return object;
				});
			let response: Response;
			try {
				response = await requestList(hash, 'discovery');
			} finally {
				get.mockRestore();
			}
			expect(response.status).toBe(503);
		}, fixtureWorkerServer()));

	it('returns the same retry headers for a pending HEAD request', async () =>
		withoutAlarmArming(async () => {
			const { hash } = await publication();
			await activate();
			const response = await requestList(hash, 'raw', 'HEAD');
			expect({
				status: response.status,
				retryAfter: response.headers.get('retry-after'),
				body: await response.text()
			}).toStrictEqual({ status: 503, retryAfter: '5', body: '' });
		}, fixtureWorkerServer()));

	it.each(['missing', 'metadata'] as const)(
		'refuses a %s object behind a ready pointer',
		async (failure) =>
			withoutAlarmArming(async () => {
				const { hash } = await publication();
				await activate();
				await refresh();
				const row = await env.CUPBOARD_DB.prepare(
					'SELECT published_key AS key FROM attestation_list_revision WHERE tenant = ? AND store_path_hash = ?'
				)
					.bind(fixtureTenant, hash)
					.first<{ key: string }>();
				if (row === null) {
					throw new Error('The immutable list pointer is missing');
				}
				if (failure === 'missing') {
					await env.BLOBS.delete(row.key);
				} else {
					await env.BLOBS.put(
						row.key,
						JSON.stringify({ attestations: [descriptor] })
					);
				}
				const response = await requestList(hash, 'discovery');
				expect(response.status).toBe(503);
			}, fixtureWorkerServer())
	);

	it('refuses a legacy raw miss when activation completes during R2 retrieval', async () =>
		withoutAlarmArming(async () => {
			const { hash } = await publication();
			await env.BLOBS.delete(
				attestationListObjectKey(fixtureTenant, hash, defaultCache())
			);
			const original = env.BLOBS.get.bind(env.BLOBS);
			const get = vi
				.spyOn(env.BLOBS, 'get')
				.mockImplementationOnce(async (key, options) => {
					const object = await original(key, options);
					await activate();
					return object;
				});
			let response: Response;
			try {
				response = await requestList(hash, 'raw');
			} finally {
				get.mockRestore();
			}
			expect(response.status).toBe(503);
		}, fixtureWorkerServer()));

	it('uses two bounded publication snapshots for a full 32-path discovery page', async () =>
		withoutAlarmArming(async () => {
			const paths = [];
			for (let index = 0; index < 32; index++) {
				const path = await committedPath(
					`list-budget-${String(index)}`,
					defaultCache(),
					{ storePathHash: index.toString(2).padStart(32, '0') }
				);
				paths.push(path);
			}
			await env.CUPBOARD_DB.prepare(
				"INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, published_revision, published_cache_generation, published_nar_hash, updated_at) SELECT tenant, cache_kind, cache_name, store_path_hash, generation, 1, cache_generation, nar_hash, '2026-10-12T00:00:00.000Z' FROM blob_ref_storage WHERE tenant = ? AND cache_kind = 'default' ON CONFLICT DO UPDATE SET published_revision = attestation_list_revision.revision, published_cache_generation = excluded.published_cache_generation, published_nar_hash = excluded.published_nar_hash"
			)
				.bind(fixtureTenant)
				.run();
			await activate();
			let snapshots = 0;
			const binding = new Proxy(env.CUPBOARD_DB, {
				get(target, property) {
					if (property === 'prepare') {
						return (query: string) => {
							if (query.includes('list_parent')) {
								snapshots++;
							}
							return target.prepare(query);
						};
					}
					const value: unknown = Reflect.get(target, property, target);
					if (typeof value !== 'function') {
						return value;
					}
					const bound: unknown = value.bind(target);
					return bound;
				}
			});
			const response = await readFetch(
				'/api/v1/attestation-info',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						storePathHashes: paths.map((path) => path.storePathHash)
					})
				},
				{ CUPBOARD_DB: binding }
			);
			expect({
				status: response.status,
				snapshots,
				body: await response.json()
			}).toStrictEqual({
				status: 200,
				snapshots: 2,
				body: {
					scopeVersion: 'cache:1:1:public:false',
					entries: paths.map((path) => ({
						storePathHash: path.storePathHash,
						status: 'found',
						narHash: path.narHash,
						attestations: []
					}))
				}
			});
		}, fixtureWorkerServer()));
	it.each([
		{ surface: 'raw', failure: 'missing' },
		{ surface: 'raw', failure: 'metadata' },
		{ surface: 'discovery', failure: 'missing' },
		{ surface: 'discovery', failure: 'metadata' }
	] as const)(
		'durably repairs a $failure object reported by the $surface reader',
		async ({ surface, failure }) => {
			await withoutAlarmArming(async () => {
				const { hash } = await publication();
				await activate();
				await refresh();
				const previous = await env.CUPBOARD_DB.prepare(
					'SELECT published_key AS key FROM attestation_list_revision WHERE tenant = ? AND store_path_hash = ?'
				)
					.bind(fixtureTenant, hash)
					.first<{ key: string }>();
				if (previous === null) {
					throw new Error('The list was not published');
				}
				if (failure === 'missing') {
					await env.BLOBS.delete(previous.key);
				} else {
					await env.BLOBS.put(
						previous.key,
						JSON.stringify({ attestations: [descriptor] })
					);
				}
				const refused = await requestList(hash, surface);
				expect(refused.status).toBe(503);
				const invalidated = await env.CUPBOARD_DB.prepare(
					'SELECT revision, published_revision AS publishedRevision, published_key AS publishedKey FROM attestation_list_revision WHERE tenant = ? AND store_path_hash = ?'
				)
					.bind(fixtureTenant, hash)
					.first<{
						revision: number;
						publishedRevision: number;
						publishedKey: string;
					}>();
				expect(invalidated).toStrictEqual({
					revision: 3,
					publishedRevision: 2,
					publishedKey: previous.key
				});
				await refresh();
				const recovered = await requestList(hash, surface);
				expect(recovered.status).toBe(200);
				expect(await env.BLOBS.head(previous.key)).toBeNull();
			}, fixtureWorkerServer());
		}
	);
	it('does not invalidate a healthy object when a repair observation is reported', async () => {
		await withoutAlarmArming(async () => {
			const { hash } = await publication();
			await activate();
			await refresh();
			const repository = new AttestationListRevisionRepository(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				fixtureTenant
			);
			const publications = await repository.publicationsFor(defaultCache(), [
				hash
			]);
			const observed = publications.get(hash);
			if (observed === undefined) {
				throw new Error('The publication is missing');
			}
			await fixtureWorkerServer().queueAttestationListRepair(
				defaultCache(),
				hash,
				observed
			);
			expect(
				await repository.publicationsFor(defaultCache(), [hash])
			).toStrictEqual(new Map([[hash, observed]]));
		}, fixtureWorkerServer());
	});

	it('does not let an old repair observation invalidate a newer completed list', async () => {
		await withoutAlarmArming(async () => {
			const { hash } = await publication();
			await activate();
			await refresh();
			const repository = new AttestationListRevisionRepository(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				fixtureTenant
			);
			const publications = await repository.publicationsFor(defaultCache(), [
				hash
			]);
			const observed = publications.get(hash);
			if (
				observed?.state.status !== 'ready' ||
				observed.state.key === undefined
			) {
				throw new Error('The publication is missing');
			}
			await env.BLOBS.delete(observed.state.key);
			await fixtureWorkerServer().queueAttestationListRepair(
				defaultCache(),
				hash,
				observed
			);
			await refresh();
			const current = await repository.publicationsFor(defaultCache(), [hash]);
			await fixtureWorkerServer().queueAttestationListRepair(
				defaultCache(),
				hash,
				observed
			);
			expect(
				await repository.publicationsFor(defaultCache(), [hash])
			).toStrictEqual(current);
		}, fixtureWorkerServer());
	});

	it('retains a newer wake when the pending scan returns an empty snapshot', async () => {
		await withoutAlarmArming(async () => {
			await publication();
			await activate();
			await refresh();
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const service = new AttestationListRefreshService(instance.context);
				await service.requestWake();
				const previous = instance.context.db
					.select()
					.from(schema.attestationListRefreshWake)
					.get();
				const repository = new AttestationListRevisionRepository(
					instance.context.d1,
					fixtureTenant
				);
				const original = repository.pendingPage.bind(repository);
				const scan = vi
					.spyOn(AttestationListRevisionRepository.prototype, 'pendingPage')
					.mockImplementationOnce(async (after, limit) => {
						const rows = await original(after, limit);
						await service.requestWake();
						return rows;
					});
				try {
					await service.advance();
				} finally {
					scan.mockRestore();
				}
				const current = instance.context.db
					.select()
					.from(schema.attestationListRefreshWake)
					.get();
				expect({
					hasNewToken: current?.token !== previous?.token,
					wakeAt: service.nextWorkAt(123)
				}).toStrictEqual({ hasNewToken: true, wakeAt: 123 });
				await service.advance();
				expect(service.nextWorkAt(123)).toBeUndefined();
			});
		}, fixtureWorkerServer());
	});

	it('repairs a broken object through successive maintenance alarms', async () => {
		await withoutAlarmArming(async () => {
			const { hash } = await publication();
			await activate();
			await refresh();
			const previous = await env.CUPBOARD_DB.prepare(
				'SELECT published_key AS key FROM attestation_list_revision WHERE tenant = ? AND store_path_hash = ?'
			)
				.bind(fixtureTenant, hash)
				.first<{ key: string }>();
			if (previous === null) {
				throw new Error('The list was not published');
			}
			await env.BLOBS.delete(previous.key);
			const refused = await requestList(hash, 'discovery');
			expect(refused.status).toBe(503);
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				for (let pass = 0; pass < 30; pass++) {
					await instance.alarm();
					if (
						new AttestationListRefreshService(instance.context).nextWorkAt(
							Date.now()
						) === undefined
					) {
						break;
					}
				}
			});
			const recovered = await requestList(hash, 'discovery');
			expect(recovered.status).toBe(200);
		}, fixtureWorkerServer());
	});
});
