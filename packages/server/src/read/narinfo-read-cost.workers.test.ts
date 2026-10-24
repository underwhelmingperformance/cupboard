import { startCapture } from '@cupboard/logger/testing';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { cacheMetadataResponseSchema } from '@cupboard/protocol/cache-metadata';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { noCost } from '../do/operation-cost.test-support.ts';
import { committedPath } from '../do/reuse-view-read.test-support.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	defaultCache,
	initialiseViaWorker,
	narBytes,
	pushPathToTenant,
	readFetch,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

/**
A D1 binding that counts round trips rather than statements: one for a batch,
whatever it holds, and one for a statement run on its own.

Admission reads the tenant row, the cache credential and the cache lifecycle
in a single batch, so a read that consults nothing else spends exactly one
round trip.
*/
function roundTripCountingD1(inner: D1Database): {
	readonly binding: D1Database;
	readonly roundTrips: () => number;
	readonly authorityReads: () => number;
} {
	let roundTrips = 0;
	let authorityReads = 0;
	const authorityStatements = new WeakSet<D1PreparedStatement>();
	const executions = new Set(['first', 'run', 'all', 'raw']);
	const counted = (
		statement: D1PreparedStatement,
		isAuthority: boolean
	): D1PreparedStatement => {
		const wrapped = new Proxy(statement, {
			get(target, property, receiver) {
				const value: unknown = Reflect.get(target, property, receiver);

				if (typeof value !== 'function') {
					return value;
				}

				if (property === 'bind') {
					return (...values: unknown[]) =>
						counted(target.bind(...values), isAuthority);
				}

				return (...parameters: unknown[]): unknown => {
					if (executions.has(String(property))) {
						roundTrips += 1;
						if (isAuthority) {
							authorityReads += 1;
						}
					}

					return Reflect.apply(value, target, parameters);
				};
			}
		});
		if (isAuthority) {
			authorityStatements.add(wrapped);
		}
		return wrapped;
	};

	return {
		roundTrips: () => roundTrips,
		authorityReads: () => authorityReads,
		binding: {
			prepare: (query) =>
				counted(
					inner.prepare(query),
					query.includes('requested_path_reference')
				),
			batch: (statements) => {
				roundTrips += 1;
				if (
					statements.some((statement) => authorityStatements.has(statement))
				) {
					authorityReads += 1;
				}

				return inner.batch(statements);
			},
			exec: (query) => {
				roundTrips += 1;

				return inner.exec(query);
			},
			withSession: (constraint) => inner.withSession(constraint),
			dump: () => Promise.reject(new Error('dump is not supported here'))
		}
	};
}

describe('public narinfo read cost', () => {
	beforeEach(resetTestServer);

	it('checks admission and path authority on a hit', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(fixtureTenant, token, metadata);

		const counting = roundTripCountingD1(env.CUPBOARD_DB);
		const response = await readFetch(
			`/${metadata.storePathHash}.narinfo`,
			undefined,
			{ CUPBOARD_DB: counting.binding }
		);

		expect({
			status: response.status,
			roundTrips: counting.roundTrips()
		}).toStrictEqual({ status: StatusCodes.OK, roundTrips: 2 });
	});

	// Without a `CUPBOARD_TENANT` binding the control Worker runs the tenant read
	// app in process, so the read app's request scope joins the control Worker's
	// and this one line contains both Workers' calls.
	it('logs the control Worker cost of a hit under its route', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(fixtureTenant, token, metadata);
		const path = `/t/${fixtureTenant}/${metadata.storePathHash}.narinfo`;

		const capture = startCapture();

		try {
			await readFetch(`/${metadata.storePathHash}.narinfo`);
		} finally {
			capture.stop();
		}

		expect(
			capture.logs
				.filter((entry) => entry.message === 'request finished')
				.map((entry) => entry.properties)
		).toStrictEqual([
			{
				method: 'GET',
				path,
				route: String.raw`/t/:tenant/:name{[0-9a-z]+\.narinfo}`,
				status: StatusCodes.OK,
				...noCost,
				d1Calls: 2,
				d1RowsRead: 6,
				r2Get: 1
			}
		]);
	});
});

it('refuses a retained public narinfo after its path fence is persisted', async () => {
	await resetTestServer();
	const token = await initialiseViaWorker();
	const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
	await pushPathToTenant(fixtureTenant, token, metadata);
	await env.CUPBOARD_DB.prepare(
		'INSERT INTO path_read_revocation(tenant,cache_kind,store_path_hash,cache_generation,generation) SELECT tenant, cache_kind, store_path_hash, cache_generation, max(generation) FROM blob_ref_storage WHERE tenant = ? AND cache_kind = ? AND store_path_hash = ? GROUP BY tenant, cache_kind, store_path_hash, cache_generation'
	)
		.bind(fixtureTenant, 'default', metadata.storePathHash)
		.run();
	const response = await readFetch(`/${metadata.storePathHash}.narinfo`);
	expect(response.status).toBe(StatusCodes.NOT_FOUND);
});

describe('public metadata page cost', () => {
	beforeEach(resetTestServer);

	it('measures full canonical pages on initial and repeated origin reads', async () => {
		const entries = [];
		for (let index = 0; index < 32; index += 1) {
			const path = await committedPath(
				`metadata-cost-${String(index)}`,
				defaultCache(),
				{ storePathHash: index.toString(2).padStart(32, '0') }
			);
			const response = await readFetch(`/${path.storePathHash}.narinfo`);
			entries.push({
				storePath: path.storePath,
				status: 'found',
				narinfo: await response.text()
			});
		}
		const samples = [];
		const gets = vi.spyOn(env.BLOBS, 'get');
		for (const size of [1, 6, 32]) {
			for (let repeat = 0; repeat < 3; repeat += 1) {
				const counting = roundTripCountingD1(env.CUPBOARD_DB);
				gets.mockClear();
				const expected = entries.slice(0, size);
				const started = performance.now();
				const response = await readFetch(
					'/api/v1/path-info',
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							storePaths: expected.map((entry) => entry.storePath)
						})
					},
					{ CUPBOARD_DB: counting.binding }
				);
				const body = cacheMetadataResponseSchema.parse(await response.json());
				const elapsedMs = performance.now() - started;
				const observed = {
					status: response.status,
					body,
					authorityReads: counting.authorityReads(),
					r2Gets: gets.mock.calls.length
				};
				expect(observed).toStrictEqual({
					status: StatusCodes.OK,
					body: { scopeVersion: 'cache:1:1:public:false', entries: expected },
					authorityReads: size + 1,
					r2Gets: size
				});
				samples.push({
					size,
					repeat,
					elapsedMs,
					roundTrips: counting.roundTrips(),
					authorityReads: counting.authorityReads(),
					r2Gets: gets.mock.calls.length
				});
			}
		}
		gets.mockRestore();
		console.info('public-metadata-origin-cost', JSON.stringify(samples));
	});

	it.each([0, 1, 6])(
		'measures a 32-path page with %s authoritative found paths',
		async (foundCount) => {
			await initialiseViaWorker();
			const expected = [];
			for (let index = 0; index < 32; index += 1) {
				const hash = index.toString(2).padStart(32, '0');
				if (index >= foundCount) {
					expected.push({
						storePath: storePathSchema.parse(
							`/nix/store/${hash}-metadata-missing`
						),
						status: 'missing'
					});
					continue;
				}
				const path = await committedPath(
					`metadata-mixed-${String(index)}`,
					defaultCache(),
					{ storePathHash: hash }
				);
				const canonical = await readFetch(`/${path.storePathHash}.narinfo`);
				expected.push({
					storePath: path.storePath,
					status: 'found',
					narinfo: await canonical.text()
				});
			}
			const gets = vi.spyOn(env.BLOBS, 'get');
			const samples = [];
			for (let repeat = 0; repeat < 3; repeat += 1) {
				const counting = roundTripCountingD1(env.CUPBOARD_DB);
				gets.mockClear();
				const started = performance.now();
				const response = await readFetch(
					'/api/v1/path-info',
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							storePaths: expected.map((entry) => entry.storePath)
						})
					},
					{ CUPBOARD_DB: counting.binding }
				);
				const body = cacheMetadataResponseSchema.parse(await response.json());
				const sample = {
					foundCount,
					repeat,
					elapsedMs: performance.now() - started,
					authorityReads: counting.authorityReads(),
					roundTrips: counting.roundTrips(),
					r2Gets: gets.mock.calls.length
				};
				expect({
					status: response.status,
					body,
					authorityReads: sample.authorityReads,
					r2Gets: sample.r2Gets
				}).toStrictEqual({
					status: StatusCodes.OK,
					body: { scopeVersion: 'cache:1:1:public:false', entries: expected },
					authorityReads: foundCount + 1,
					r2Gets: foundCount
				});
				samples.push(sample);
			}
			gets.mockRestore();
			console.info(
				'public-metadata-origin-missing-cost',
				JSON.stringify(samples)
			);
		}
	);

	it('counts canonical reads beyond the continuation prefix', async () => {
		const entries = [];
		for (let index = 0; index < 32; index += 1) {
			const path = await committedPath(
				`metadata-continuation-${String(index)}`,
				defaultCache(),
				{ storePathHash: index.toString(2).padStart(32, '0') }
			);
			const key = narInfoObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(path.storePathHash),
				defaultCache()
			);
			const canonical = await readFetch(`/${path.storePathHash}.narinfo`);
			await canonical.text();
			const object = await env.BLOBS.get(key);
			if (object === null) {
				throw new Error('Missing committed narinfo fixture');
			}
			const original = await object.text();
			const narinfo = NarInfo.parse(
				original.replaceAll(/^CA:.*\n/gmu, '') +
					(index < 5 ? `CA: ${'x'.repeat(850_000)}\n` : '')
			).render();
			await env.BLOBS.put(key, narinfo, {
				customMetadata: object.customMetadata,
				httpMetadata: object.httpMetadata
			});
			entries.push({ storePath: path.storePath, status: 'found', narinfo });
		}
		const outcomes = [];
		for (const start of [0, 4]) {
			const counting = roundTripCountingD1(env.CUPBOARD_DB);
			const started = performance.now();
			const response = await readFetch(
				'/api/v1/path-info',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						storePaths: entries.slice(start).map((entry) => entry.storePath)
					})
				},
				{ CUPBOARD_DB: counting.binding }
			);
			const body = cacheMetadataResponseSchema.parse(await response.json());
			outcomes.push({
				status: response.status,
				body,
				authorityReads: counting.authorityReads(),
				roundTrips: counting.roundTrips()
			});
			console.info(
				'public-metadata-origin-continuation-cost',
				JSON.stringify({
					start,
					elapsedMs: performance.now() - started,
					returnedPaths: body.entries.length,
					nextIndex: body.nextIndex,
					authorityReads: counting.authorityReads(),
					roundTrips: counting.roundTrips()
				})
			);
		}
		expect(outcomes).toStrictEqual([
			{
				status: StatusCodes.OK,
				body: {
					scopeVersion: 'cache:1:1:public:false',
					entries: entries.slice(0, 4),
					nextIndex: 4
				},
				authorityReads: 7,
				roundTrips: 9
			},
			{
				status: StatusCodes.OK,
				body: {
					scopeVersion: 'cache:1:1:public:false',
					entries: entries.slice(4)
				},
				authorityReads: 29,
				roundTrips: 31
			}
		]);
	});
});
