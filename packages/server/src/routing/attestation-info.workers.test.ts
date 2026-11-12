import {
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	attestationInfoErrorSchema,
	attestationInfoMaxListBytes,
	attestationInfoResponseSchema
} from '@cupboard/protocol/attestations';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { committedPath } from '../do/reuse-view-read.test-support.ts';
import { attestationListObjectKey } from '../http/http.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';
import {
	defaultCache,
	flakyD1,
	initialiseViaWorker,
	loggedAtWarning,
	namedCache,
	provisionFixtureTenant,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer,
	workerFetch
} from '../test-support.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const stringMatcher: unknown = expect.any(String);

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
		['other', 'public', []],
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
			const current = narInfoGenerationSchema.parse(
				versions.get(hash)?.generation
			);
			const recorded = {
				current: String(current),
				other: String(current + 1),
				none: undefined
			}[generation ?? 'none'];
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

	it('refuses an oversized list whose source has already failed', async () => {
		const path = await committedPath('discovery-failed-source', defaultCache());
		await env.BLOBS.put(
			attestationListObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(path.storePathHash),
				defaultCache()
			),
			' '.repeat(attestationInfoMaxListBytes + 1)
		);
		const failed = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error('source failed'));
			}
		});
		const bucket = new Proxy(env.BLOBS, {
			get(target, key, receiver): unknown {
				if (key === 'get') {
					return async (objectKey: string) => {
						const object = await target.get(objectKey);
						if (object === null) {
							return object;
						}
						await object.body.cancel();
						return new Proxy(object, {
							get(stored, member): unknown {
								if (member === 'body') {
									return failed;
								}
								const value: unknown = Reflect.get(stored, member, stored);
								return typeof value === 'function' ? value.bind(stored) : value;
							}
						});
					};
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
		const { code, storePathHash } = attestationInfoErrorSchema.parse(
			await response.json()
		);
		expect({ status: response.status, code, storePathHash }).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			code: 'list-too-large',
			storePathHash: path.storePathHash
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

	it('logs the request fields when the reference read fails', async () => {
		const path = await committedPath('discovery-reference-log', defaultCache());
		const failing = flakyD1(env.CUPBOARD_DB, {
			failures: Number.MAX_SAFE_INTEGER,
			matches: (query) => query.includes('requested_path_reference')
		});
		const logged = await loggedAtWarning(async () => {
			const response = await readFetch(
				'/api/v1/attestation-info',
				probe([path.storePathHash]),
				{ CUPBOARD_DB: failing }
			);
			expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
		});

		expect(logged).toStrictEqual([
			{
				level: 'warning',
				category: ['cupboard'],
				message: 'request refused: cache facts unavailable',
				properties: {
					requestId: stringMatcher,
					method: 'POST',
					path: `/t/${fixtureTenant}/api/v1/attestation-info`,
					tenant: fixtureTenant,
					step: 'narinfo-reference-read',
					error: new Error('transient D1 fault')
				}
			}
		]);
	});

	it('logs one record when several list reads fail', async () => {
		const paths = [
			await committedPath('discovery-provider-log-1', defaultCache(), {
				storePathHash: 'a'.repeat(32)
			}),
			await committedPath('discovery-provider-log-2', defaultCache(), {
				storePathHash: 'b'.repeat(32)
			})
		];
		const outage = new Error('provider unavailable');
		const bucket = new Proxy(env.BLOBS, {
			get(target, key, receiver): unknown {
				if (key === 'get') {
					return () => Promise.reject(outage);
				}
				const value: unknown = Reflect.get(target, key, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const logged = await loggedAtWarning(async () => {
			const response = await readFetch(
				'/api/v1/attestation-info',
				probe(paths.map((path) => path.storePathHash)),
				{ BLOBS: bucket }
			);
			expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
		});

		expect(logged).toStrictEqual([
			{
				level: 'warning',
				category: ['cupboard'],
				message: 'request refused: cache facts unavailable',
				properties: {
					requestId: stringMatcher,
					method: 'POST',
					path: `/t/${fixtureTenant}/api/v1/attestation-info`,
					tenant: fixtureTenant,
					step: 'attestation-list-read',
					error: outage
				}
			}
		]);
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
