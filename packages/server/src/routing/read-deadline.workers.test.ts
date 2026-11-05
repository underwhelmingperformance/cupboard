import { startCapture } from '@cupboard/logger/testing';
import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tenantMemberKey } from '../control/tenant-member-key.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { committedPath } from '../do/reuse-view-read.test-support.ts';
import { attestationListObjectKey, narInfoObjectKey } from '../http/http.ts';
import {
	passThrough,
	stalledBody,
	streamRecords
} from '../http/stalled-body.test-support.ts';
import { readRequestBudgetMs } from '../policy/streaming.ts';
import {
	defaultCache,
	initialiseViaWorker,
	provisionFixtureTenant,
	readFetch,
	recordTransition,
	resetTestServer
} from '../test-support.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const reader = { user: 'alice', password: 'secret' };
const credentials = `Basic ${btoa(`${reader.user}:${reader.password}`)}`;
const sentBytes = 4;

// The control Worker gives each request an ID, which differs on every request.
const variableFields = ['requestId'];

/**
A bucket whose read of `key` returns a body that delivers `sentBytes` bytes
and then stalls. `stalled` resolves when the read has returned that body.
*/
function stallingReadOf(
	bucket: R2Bucket,
	key: string
): { readonly blobs: R2Bucket; readonly stalled: Promise<undefined> } {
	const stalled = Promise.withResolvers<undefined>();
	const blobs = new Proxy(bucket, {
		get(target, property) {
			if (property !== 'get') {
				return passThrough(target, property);
			}

			return async (read: string, options?: R2GetOptions) => {
				const object = await target.get(read, options);

				if (read !== key || object === null || !('body' in object)) {
					return object;
				}

				await object.body.cancel();
				const body = await stalledBody(sentBytes);
				stalled.resolve(undefined);

				return new Proxy(object, {
					get(stored, member) {
						return member === 'body' ? body : passThrough(stored, member);
					}
				});
			};
		}
	});

	return { blobs, stalled: stalled.promise };
}

interface StoredProbe {
	readonly key: string;
	readonly init: RequestInit;
}

interface ProbeRoute {
	readonly name: string;
	readonly path: string;
	readonly operation: string;
	readonly store: () => Promise<StoredProbe>;
}

const probes: readonly ProbeRoute[] = [
	{
		name: 'the path-info probe of a private cache',
		path: '/api/v1/path-info',
		operation: 'path-info.body',
		store: async () => {
			await initialiseViaWorker();
			await provisionFixtureTenant({ read: reader });
			const path = await committedPath('stalled-path-info', defaultCache(), {
				access: 'private'
			});

			return {
				key: narInfoObjectKey(
					fixtureTenant,
					storePathHashSchema.parse(path.storePathHash),
					defaultCache()
				),
				init: {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: credentials
					},
					body: JSON.stringify({ storePaths: [path.storePath] })
				}
			};
		}
	},
	{
		name: 'the attestation-info probe',
		path: '/api/v1/attestation-info',
		operation: 'attestation-info.body',
		store: async () => {
			const path = await committedPath(
				'stalled-attestation-info',
				defaultCache()
			);
			const key = attestationListObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(path.storePathHash),
				defaultCache()
			);
			await env.BLOBS.put(key, JSON.stringify({ attestations: [] }));

			return {
				key,
				init: {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ storePathHashes: [path.storePathHash] })
				}
			};
		}
	}
];

async function storedSize(key: string): Promise<number> {
	const object = await env.BLOBS.head(key);

	if (object === null) {
		throw new TypeError(`${key} is not stored`);
	}

	return object.size;
}

describe('a read probe whose R2 body stalls', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(probes)(
		'refuses $name retryably at the read deadline',
		async (probe) => {
			const { key, init } = await probe.store();
			const size = await storedSize(key);
			const { blobs, stalled } = stallingReadOf(env.BLOBS, key);
			const capture = startCapture();
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

			try {
				const responding = readFetch(probe.path, init, { BLOBS: blobs });
				await stalled;
				await vi.advanceTimersByTimeAsync(readRequestBudgetMs);
				const response = await responding;

				expect({
					status: response.status,
					retryAfter: response.headers.get('retry-after'),
					cacheControl: response.headers.get('cache-control'),
					records: streamRecords(capture.logs, variableFields)
				}).toStrictEqual({
					status: StatusCodes.SERVICE_UNAVAILABLE,
					retryAfter: '5',
					cacheControl: 'no-store',
					records: [
						{
							level: 'warning',
							category: ['cupboard', 'storage', 'stream'],
							message: 'response body deadline passed',
							properties: {
								requestId: 'string',
								operation: probe.operation,
								objectKey: key,
								length: size,
								deadlineMs: readRequestBudgetMs
							}
						}
					]
				});
			} finally {
				capture.stop();
			}
		}
	);
});

const unpublishedHash = '0'.repeat(32);

/**
A binding call that never returns. `reached` runs when the call starts.
*/
function stalledCall(reached: () => void): Promise<never> {
	reached();

	return Promise.race([]);
}

/**
A tenant object namespace whose stubs stall every call of `method`.
*/
function stallingTenantObjects(
	method: 'authoriseCacheContentRead' | 'migrateCacheCatalogue',
	reached: () => void
): DurableObjectNamespace {
	return new Proxy(env.CUPBOARD_DO, {
		get(target, property) {
			if (property !== 'get') {
				return passThrough(target, property);
			}

			return (id: DurableObjectId) =>
				new Proxy(target.get(id), {
					get(stub, member) {
						return member === method
							? () => stalledCall(reached)
							: passThrough(stub, member);
					}
				});
		}
	});
}

/**
A KV namespace whose reads of `key` stall.
*/
function stallingKv(key: string, reached: () => void): KVNamespace {
	return new Proxy(env.TENANT_CACHE, {
		get(target, property) {
			const value = passThrough(target, property);

			if (property !== 'get' || typeof value !== 'function') {
				return value;
			}

			return (read: string, ...options: unknown[]): unknown =>
				read === key
					? stalledCall(reached)
					: Reflect.apply(value, undefined, [read, ...options]);
		}
	});
}

interface StalledAdmission {
	readonly bindings: Partial<Env>;
	readonly restore: () => void;
}

interface AdmissionStall {
	readonly wait: string;
	readonly authorization: string;
	readonly stall: (reached: () => void) => Promise<StalledAdmission>;
}

function nothingToRestore(): void {
	// A stall that replaces only bindings leaves nothing behind.
}

const markerStall: AdmissionStall = {
	wait: 'the KV read of the membership marker',
	authorization: credentials,
	stall: (reached) =>
		Promise.resolve({
			bindings: {
				TENANT_CACHE: stallingKv(tenantMemberKey(fixtureTenant), reached)
			},
			restore: nothingToRestore
		})
};

const admissionStalls: readonly AdmissionStall[] = [
	{
		wait: 'the Cache API read of the membership filter',
		authorization: credentials,
		stall: (reached) => {
			const match = vi
				.spyOn(caches.default, 'match')
				.mockImplementation(() => stalledCall(reached));

			return Promise.resolve({
				bindings: {},
				restore: () => {
					match.mockRestore();
				}
			});
		}
	},
	{
		wait: 'the KV read of the membership filter',
		authorization: credentials,
		stall: (reached) => {
			const match = vi
				.spyOn(caches.default, 'match')
				.mockResolvedValue(undefined);

			return Promise.resolve({
				bindings: { TENANT_CACHE: stallingKv('tenant-filter', reached) },
				restore: () => {
					match.mockRestore();
				}
			});
		}
	},
	markerStall,
	{
		wait: 'the read-token check',
		authorization: 'Bearer token',
		stall: (reached) =>
			Promise.resolve({
				bindings: {
					CUPBOARD_DO: stallingTenantObjects(
						'authoriseCacheContentRead',
						reached
					)
				},
				restore: nothingToRestore
			})
	},
	{
		wait: 'the cache catalogue migration',
		authorization: credentials,
		stall: async (reached) => {
			await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
				.update(d1Schema.tenant)
				.set({ cacheCatalogueVersion: sql`null` })
				.where(eq(d1Schema.tenant.id, fixtureTenant));

			return {
				bindings: {
					CUPBOARD_DO: stallingTenantObjects('migrateCacheCatalogue', reached)
				},
				restore: nothingToRestore
			};
		}
	}
];

interface BoundedRead {
	readonly name: string;
	readonly path: string;
	readonly init: (authorization: string) => RequestInit;
}

const narInfoRead: BoundedRead = {
	name: 'a narinfo read',
	path: `/${unpublishedHash}.narinfo`,
	init: (authorization) => ({ headers: { authorization } })
};

const boundedReads: readonly BoundedRead[] = [
	narInfoRead,
	{
		name: 'the path-info probe',
		path: '/api/v1/path-info',
		init: (authorization) => ({
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization },
			body: JSON.stringify({
				storePaths: [`/nix/store/${unpublishedHash}-unpublished`]
			})
		})
	},
	{
		name: 'the attestation-info probe',
		path: '/api/v1/attestation-info',
		init: (authorization) => ({
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization },
			body: JSON.stringify({ storePathHashes: [unpublishedHash] })
		})
	}
];

// The deadline must start before admission at every mount of the read routes.
const cachePrefixes = [
	{ cache: 'the default cache', prefix: '' },
	{ cache: 'a named cache', prefix: '/cache/builds' }
] as const;

async function stalledAdmissionResponse(
	read: BoundedRead,
	admission: AdmissionStall,
	prefix: string
): Promise<unknown> {
	const reached = Promise.withResolvers<undefined>();
	const { bindings, restore } = await admission.stall(() => {
		reached.resolve(undefined);
	});
	const capture = startCapture();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

	try {
		const responding = readFetch(
			`${prefix}${read.path}`,
			read.init(admission.authorization),
			bindings
		);
		await reached.promise;
		await vi.advanceTimersByTimeAsync(readRequestBudgetMs);
		// After a KV read fails, admission reads D1, and the deadline refuses the
		// read. Admission retries a refused D1 read once, after a delay on the
		// same timers.
		await vi.runAllTimersAsync();
		const response = await responding;

		return {
			status: response.status,
			retryAfter: response.headers.get('retry-after'),
			cacheControl: response.headers.get('cache-control'),
			records: streamRecords(capture.logs, variableFields)
		};
	} finally {
		restore();
		capture.stop();
	}
}

const refusedAtDeadline = {
	status: StatusCodes.SERVICE_UNAVAILABLE,
	retryAfter: '5',
	cacheControl: 'no-store',
	records: []
};

describe('a read whose admission stalls', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
		await initialiseViaWorker();
		await provisionFixtureTenant({
			read: reader,
			defaultCacheAccess: 'private'
		});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(
		admissionStalls.flatMap((admission) =>
			cachePrefixes.map((cache) => ({ ...admission, ...cache }))
		)
	)(
		'refuses a narinfo read from $cache retryably when $wait stalls past the read deadline',
		async ({ prefix, ...admission }) => {
			expect(
				await stalledAdmissionResponse(narInfoRead, admission, prefix)
			).toStrictEqual(refusedAtDeadline);
		}
	);

	it.each(
		boundedReads.flatMap((read) =>
			cachePrefixes.map((cache) => ({ read, ...cache }))
		)
	)(
		'starts the deadline of $read.name for $cache before admission',
		async ({ read, prefix }) => {
			expect(
				await stalledAdmissionResponse(read, markerStall, prefix)
			).toStrictEqual(refusedAtDeadline);
		}
	);
});
