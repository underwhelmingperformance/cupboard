import { StorePath } from '@cupboard/nix-store/store-path';
import {
	cacheIntersectionMaxHashes,
	cacheIntersectionMaxRequestBytes,
	cacheIntersectionMaxResponseBytes,
	cacheIntersectionResponseSchema
} from '@cupboard/protocol/cache-metadata';
import { tenantReadCredentialSchema } from '@cupboard/protocol/tenants';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import { setTenantReadCredential } from '../control/tenant-registry.ts';
import { sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { committedPath } from '../do/reuse-view-read.test-support.ts';
import {
	currentOrigin,
	defaultCache,
	initialiseViaWorker,
	namedCache,
	provisionFixtureTenant,
	readFetch,
	recordTransition,
	resetTestServer
} from '../test-support.ts';
import worker from '../worker.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const missing = Array.from({ length: 300 }, (_, index) =>
	String(index).padStart(32, '0')
);

function probe(
	storePathHashes: readonly string[],
	expectedScopeVersion?: string
): RequestInit<IncomingRequestCfProperties> {
	return {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Basic ${btoa('alice:secret')}`
		},
		body: JSON.stringify({
			operation: 'intersection',
			storePathHashes,
			...(expectedScopeVersion && { expectedScopeVersion })
		})
	};
}

function afterRange(mutate: () => Promise<void>): D1Database {
	const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, key, receiver): unknown {
				if (key === 'bind') {
					return (...arguments_: Parameters<D1PreparedStatement['bind']>) =>
						wrap(target.bind(...arguments_));
				}
				if (key === 'raw') {
					return async () => {
						const rows = await target.raw();
						await mutate();
						return rows;
					};
				}
				const value: unknown = Reflect.get(target, key, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
	return new Proxy(env.CUPBOARD_DB, {
		get(target, key, receiver): unknown {
			if (key === 'prepare') {
				return (query: string) =>
					query.includes('"blob_ref_storage"') &&
					query.includes('limit ?') &&
					!query.includes('json_each')
						? wrap(target.prepare(query))
						: target.prepare(query);
			}
			const value: unknown = Reflect.get(target, key, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

describe('direct cache intersection resource', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
		await initialiseViaWorker();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
	});

	it.each([
		{ kind: 'default', access: 'public' },
		{ kind: 'default', access: 'private' },
		{ kind: 'named', access: 'public' },
		{ kind: 'named', access: 'private' }
	] as const)(
		'returns sparse possible matches for $access $kind',
		async ({ kind, access }) => {
			const cache = kind === 'default' ? defaultCache() : namedCache('falcon');
			const path = await committedPath('intersection', cache, { access });
			const hashes = [...missing, path.storePathHash];
			const response = await readFetch(
				`${kind === 'default' ? '' : '/cache/falcon'}/api/v1/path-info`,
				probe(hashes)
			);
			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				body: await response.json()
			}).toStrictEqual({
				status: 200,
				cacheControl: 'no-store',
				body: {
					complete: true,
					scopeVersion: `cache:1:${String(kind === 'default' && access === 'private' ? 2 : 1)}:${access}:false`,
					checked: hashes.length,
					inputFingerprint: await sha256Hex(JSON.stringify(hashes)),
					matchingHashes: [StorePath.hash(path.storePath)]
				}
			});
		}
	);

	it.each(['generation', 'deletion', 'access', 'credential'] as const)(
		'refuses an empty result after concurrent %s change',
		async (mutation) => {
			const cache = namedCache('falcon');
			await committedPath('intersection-mutation', cache, {
				access: 'private'
			});
			let mutations = 0;
			const database = afterRange(async () => {
				mutations += 1;
				if (mutation === 'credential') {
					await setTenantReadCredential(
						drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
						fixtureTenant,
						tenantReadCredentialSchema.parse({
							user: 'alice',
							password: 'x'.repeat(43)
						})
					);
					return;
				}
				const assignment =
					mutation === 'generation'
						? 'generation = 2'
						: mutation === 'deletion'
							? "deleted_at = '2026-01-01T00:00:00.000Z'"
							: "access = 'public'";
				await env.CUPBOARD_DB.prepare(
					`UPDATE cache_lifecycle_storage SET ${assignment} WHERE tenant = ? AND cache_kind = 'named' AND cache_name = 'falcon'`
				)
					.bind(fixtureTenant)
					.run();
			});
			const overridden = new Proxy(env, {
				get(target, key, receiver): unknown {
					return key === 'CUPBOARD_DB'
						? database
						: Reflect.get(target, key, receiver);
				}
			});
			const context = createExecutionContext();
			const response = await worker.fetch(
				new Request<unknown, IncomingRequestCfProperties>(
					`${currentOrigin()}/t/${fixtureTenant}/cache/falcon/api/v1/path-info`,
					probe(missing)
				),
				overridden,
				context
			);
			await waitOnExecutionContext(context);
			expect({
				status: response.status,
				mutations,
				cacheControl: response.headers.get('cache-control')
			}).toStrictEqual({
				status: mutation === 'credential' ? 401 : 409,
				mutations: 1,
				cacheControl: 'no-store'
			});
		}
	);

	it('accepts a complete maximum-sized request and caps its response', async () => {
		const hashes = Array.from(
			{ length: cacheIntersectionMaxHashes },
			(_, index) => String(index).padStart(32, '0')
		);
		const init = probe(hashes);
		expect(
			new TextEncoder().encode(
				JSON.stringify({ operation: 'intersection', storePathHashes: hashes })
			).byteLength
		).toBeLessThan(2_000_000);
		expect(
			new TextEncoder().encode(
				JSON.stringify({ operation: 'intersection', storePathHashes: hashes })
			).byteLength
		).toBeLessThan(cacheIntersectionMaxRequestBytes);
		const response = await readFetch('/api/v1/path-info', init);
		const bytes = await response.arrayBuffer();
		expect(bytes.byteLength).toBeLessThan(cacheIntersectionMaxResponseBytes);
		const result = cacheIntersectionResponseSchema.parse(
			JSON.parse(new TextDecoder().decode(bytes))
		);
		expect(result).toStrictEqual({
			complete: true,
			scopeVersion: 'cache:1:1:public:false',
			checked: hashes.length,
			inputFingerprint: await sha256Hex(JSON.stringify(hashes)),
			matchingHashes: []
		});
	});

	it('refuses intersection operations on reuse views', async () => {
		const response = await readFetch(
			'/reuse/view/api/v1/path-info',
			probe(missing)
		);
		expect({
			advertised: (
				response.headers.get('x-cupboard-read-capabilities') ?? ''
			).includes('path-intersection-v1'),
			status: response.status
		}).toStrictEqual({ advertised: false, status: 400 });
	});
});
