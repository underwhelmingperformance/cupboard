import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import {
	attestationInfoMaxListBytes,
	attestationInfoResponseSchema
} from '@cupboard/protocol/attestations';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { committedPath } from '../do/reuse-view-read.test-support.ts';
import { attestationListObjectKey } from '../http/http.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';
import {
	defaultCache,
	initialiseViaWorker,
	namedCache,
	provisionFixtureTenant,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer,
	workerFetch
} from '../test-support.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const slsa = 'https://slsa.dev/provenance/v1';
const other = 'https://example.org/predicate';
const descriptors = [
	{ digest: 'a'.repeat(64), predicateType: slsa, size: 100 },
	{ digest: 'b'.repeat(64), predicateType: other, size: 200 }
];

const utf8 = new TextEncoder();
const invalidUtf8Prefix = utf8.encode(
	`{"attestations":[{"digest":"${'a'.repeat(64)}","predicateType":"https://example.org/`
);
const invalidUtf8Suffix = utf8.encode('","size":1}]}');
const invalidUtf8 = new Uint8Array([
	...invalidUtf8Prefix,
	255,
	...invalidUtf8Suffix
]);

function probe(
	hashes: readonly string[],
	additional: Record<string, unknown> = {},
	isAuthorised = false
): RequestInit {
	return {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(isAuthorised && { authorization: `Basic ${btoa('alice:secret')}` })
		},
		body: JSON.stringify({ storePathHashes: hashes, ...additional })
	};
}

describe('attestation discovery', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});

	it.each([
		{ surface: 'Worker', fetch: readFetch, cache: 'default', prefix: '' },
		{
			surface: 'Worker',
			fetch: readFetch,
			cache: 'named',
			prefix: '/cache/legacy'
		},
		{
			surface: 'Durable Object',
			fetch: workerFetch,
			cache: 'default',
			prefix: ''
		},
		{
			surface: 'Durable Object',
			fetch: workerFetch,
			cache: 'named',
			prefix: '/cache/legacy'
		}
	])(
		'returns 404 for the removed probe on the $surface with the $cache cache',
		async ({ fetch, prefix }) => {
			const token = await initialiseViaWorker();
			await putWorkerTestCache(token, namedCache('legacy'));

			const response = await fetch(
				`${prefix}/api/v1/attested-paths`,
				probe(['0'.repeat(32)])
			);

			expect(response.status).toBe(404);
		}
	);

	it.each([
		[undefined, descriptors],
		[[slsa], [descriptors[0]]],
		[[slsa, other], descriptors],
		[[`${slsa}/`], []]
	])('filters by exact predicate type %j', async (predicateTypes, expected) => {
		const path = await committedPath('discovery-filters', defaultCache());
		await env.BLOBS.put(
			attestationListObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(path.storePathHash),
				defaultCache()
			),
			JSON.stringify({ attestations: descriptors })
		);
		const response = await readFetch(
			'/api/v1/attestation-info',
			probe([path.storePathHash], {
				...(predicateTypes !== undefined && { predicateTypes })
			})
		);
		expect({
			status: response.status,
			body: attestationInfoResponseSchema.parse(await response.json())
		}).toStrictEqual({
			status: 200,
			body: {
				scopeVersion: 'cache:1:1:public:false',
				entries: [
					{
						storePathHash: path.storePathHash,
						status: 'found',
						narHash: path.narHash,
						attestations: expected
					}
				]
			}
		});
	});

	it.each([
		[undefined, 'public', descriptors],
		['0', 'public', []],
		[undefined, 'private', []],
		['current', 'private', descriptors]
	] as const)(
		'checks generation metadata %s for %s lists',
		async (generation, access, expected) => {
			await initialiseViaWorker();
			await provisionFixtureTenant({
				read: { user: 'alice', password: 'secret' }
			});
			const path = await committedPath('discovery-generation', defaultCache(), {
				access
			});
			const hash = storePathHashSchema.parse(path.storePathHash);
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const versions = await authorisedNarInfoVersions(
				database,
				fixtureTenant,
				defaultCache(),
				[hash]
			);
			const recorded =
				generation === 'current'
					? String(versions.get(hash)?.generation)
					: generation;
			await env.BLOBS.put(
				attestationListObjectKey(fixtureTenant, hash, defaultCache()),
				JSON.stringify({ attestations: descriptors }),
				{
					customMetadata:
						recorded === undefined ? {} : { 'narinfo-generation': recorded }
				}
			);
			const response = await readFetch(
				'/api/v1/attestation-info',
				probe([path.storePathHash], {}, true)
			);
			expect({
				status: response.status,
				body: attestationInfoResponseSchema.parse(await response.json())
			}).toStrictEqual({
				status: 200,
				body: {
					scopeVersion: `cache:1:${access === 'private' ? '2' : '1'}:${access}:false`,
					entries: [
						{
							storePathHash: path.storePathHash,
							status: 'found',
							narHash: path.narHash,
							attestations: expected
						}
					]
				}
			});
		}
	);

	it.each([
		['invalid JSON', '{', 'list-invalid', 502],
		[
			'invalid descriptor',
			JSON.stringify({ attestations: [{ digest: 'invalid' }] }),
			'list-invalid',
			502
		],
		[
			'oversized list',
			' '.repeat(attestationInfoMaxListBytes + 1),
			'list-too-large',
			413
		],
		['invalid UTF-8', invalidUtf8, 'list-invalid', 502]
	] as const)('refuses an %s', async (_description, body, code, status) => {
		const path = await committedPath('discovery-invalid', defaultCache());
		await env.BLOBS.put(
			attestationListObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(path.storePathHash),
				defaultCache()
			),
			body
		);
		const response = await readFetch(
			'/api/v1/attestation-info',
			probe([path.storePathHash])
		);
		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status,
			body: {
				code,
				message:
					code === 'list-too-large'
						? 'The attestation list exceeds 1 MiB.'
						: 'The cache returned an invalid attestation list.',
				storePathHash: path.storePathHash
			}
		});
	});

	it('limits Worker object reads to six and returns a bounded processed prefix', async () => {
		const largeDescriptors = Array.from({ length: 1600 }, () => ({
			...descriptors[0],
			predicateType: `https://example.org/${'a'.repeat(480)}`
		}));
		const paths = [];
		for (let index = 0; index < 6; index++) {
			const path = await committedPath(
				`discovery-page-${String(index)}`,
				defaultCache(),
				{ storePathHash: index.toString(2).padStart(32, '0') }
			);
			paths.push(path);
			await env.BLOBS.put(
				attestationListObjectKey(
					fixtureTenant,
					storePathHashSchema.parse(path.storePathHash),
					defaultCache()
				),
				JSON.stringify({ attestations: largeDescriptors })
			);
		}
		let active = 0;
		let maximum = 0;
		let calls = 0;
		const barrier = Promise.withResolvers<undefined>();
		const bucket = new Proxy(env.BLOBS, {
			get(target, key, receiver): unknown {
				if (key === 'get') {
					return async (objectKey: string) => {
						calls++;
						active++;
						maximum = Math.max(maximum, active);
						if (active === 6) {
							barrier.resolve(undefined);
						}
						await barrier.promise;
						try {
							return await target.get(objectKey);
						} finally {
							active--;
						}
					};
				}
				const value: unknown = Reflect.get(target, key, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const hashes = paths.map((path) => path.storePathHash);
		const response = await readFetch(
			'/api/v1/attestation-info',
			probe(hashes),
			{ BLOBS: bucket }
		);
		const text = await response.text();
		const body = attestationInfoResponseSchema.parse(JSON.parse(text));
		expect({ maximum, calls, status: response.status, body }).toStrictEqual({
			maximum: 6,
			calls: 6,
			status: 200,
			body: {
				scopeVersion: 'cache:1:1:public:false',
				entries: paths.slice(0, 4).map((path) => ({
					storePathHash: path.storePathHash,
					status: 'found',
					narHash: path.narHash,
					attestations: largeDescriptors
				})),
				nextIndex: 4
			}
		});
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
			4 * 1024 * 1024
		);
		const continuation = await readFetch(
			'/api/v1/attestation-info',
			probe(hashes.slice(body.nextIndex), {
				expectedScopeVersion: body.scopeVersion
			})
		);
		expect(
			attestationInfoResponseSchema.parse(await continuation.json())
		).toStrictEqual({
			scopeVersion: body.scopeVersion,
			entries: paths.slice(4).map((path) => ({
				storePathHash: path.storePathHash,
				status: 'found',
				narHash: path.narHash,
				attestations: largeDescriptors
			}))
		});
	});

	it('bounds request bytes before reading stored lists', async () => {
		const path = await committedPath('discovery-request-size', defaultCache());
		const response = await readFetch('/api/v1/attestation-info', {
			method: 'POST',
			body: JSON.stringify({
				storePathHashes: [path.storePathHash],
				predicateTypes: ['x'.repeat(64 * 1024)]
			})
		});
		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: 413,
			body: {
				code: 'request-too-large',
				message:
					'The attestation discovery request exceeds 64 KiB. Split the paths into smaller pages.'
			}
		});
	});

	it('preserves provider failures from list reads', async () => {
		const path = await committedPath(
			'discovery-provider-failure',
			defaultCache()
		);
		const bucket = new Proxy(env.BLOBS, {
			get(target, key, receiver): unknown {
				if (key === 'get') {
					return () => Promise.reject(new Error('provider unavailable'));
				}
				const value: unknown = Reflect.get(target, key, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const response = await readFetch(
			'/api/v1/attestation-info',
			probe([path.storePathHash]),
			{ BLOBS: bucket }
		);
		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({ status: 503, cacheControl: 'no-store' });
	});

	it('rejects an access change during a page without forwarding object reads to the tenant', async () => {
		const token = await initialiseViaWorker();
		const path = await committedPath('discovery-scope-change', defaultCache());
		await env.BLOBS.delete(
			attestationListObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(path.storePathHash),
				defaultCache()
			)
		);
		let forwarded = 0;
		const tenant: Env['CUPBOARD_TENANT'] = {
			fetch() {
				forwarded++;
				return Promise.reject(new Error('unexpected tenant forwarding'));
			},
			connect() {
				throw new Error('unexpected tenant connection');
			}
		};
		const bucket = new Proxy(env.BLOBS, {
			get(target, key, receiver): unknown {
				if (key === 'get') {
					return async (objectKey: string) => {
						await putWorkerTestCache(token, defaultCache(), 'private');
						return target.get(objectKey);
					};
				}
				const value: unknown = Reflect.get(target, key, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const response = await readFetch(
			'/api/v1/attestation-info',
			probe([path.storePathHash]),
			{ BLOBS: bucket, CUPBOARD_TENANT: tenant }
		);
		expect({
			forwarded,
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			forwarded: 0,
			status: 409,
			body: {
				code: 'scope-changed',
				message:
					'The cache changed during attestation discovery. Refresh the discovery page before retrying.'
			}
		});
	});

	it('revalidates a private read credential after list reads', async () => {
		await initialiseViaWorker();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		const path = await committedPath(
			'discovery-revoked-credential',
			defaultCache(),
			{ access: 'private' }
		);
		const bucket = new Proxy(env.BLOBS, {
			get(target, key, receiver): unknown {
				if (key === 'get') {
					return async (objectKey: string) => {
						const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
						await database
							.update(d1Schema.tenant)
							.set({
								readUser: sql`null`,
								readPasswordHash: sql`null`,
								readPasswordSalt: sql`null`
							})
							.where(eq(d1Schema.tenant.id, fixtureTenant));
						return target.get(objectKey);
					};
				}
				const value: unknown = Reflect.get(target, key, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const response = await readFetch(
			'/api/v1/attestation-info',
			probe([path.storePathHash], {}, true),
			{ BLOBS: bucket }
		);
		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({ status: 401, cacheControl: 'no-store' });
	});

	it('refuses private reads and stale scope versions', async () => {
		await initialiseViaWorker();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		const path = await committedPath('discovery-private', defaultCache(), {
			access: 'private'
		});
		const denied = await readFetch(
			'/api/v1/attestation-info',
			probe([path.storePathHash])
		);
		const stale = await readFetch(
			'/api/v1/attestation-info',
			probe(
				[path.storePathHash],
				{ expectedScopeVersion: 'cache:1:1:public:false' },
				true
			)
		);
		expect({
			denied: denied.status,
			stale: stale.status,
			body: await stale.json()
		}).toStrictEqual({
			denied: 401,
			stale: 409,
			body: {
				code: 'scope-changed',
				message:
					'The cache changed during attestation discovery. Refresh the discovery page before retrying.'
			}
		});
	});

	it.each([
		[[]],
		[['bad']],
		[['0'.repeat(32), '0'.repeat(32)]],
		[
			Array.from({ length: 33 }, (_, index) =>
				index.toString(2).padStart(32, '0')
			)
		]
	])('refuses invalid path hashes %j', async (hashes) => {
		await committedPath('discovery-validation', defaultCache());
		const response = await readFetch('/api/v1/attestation-info', probe(hashes));
		expect(response.status).toBe(400);
	});
});
