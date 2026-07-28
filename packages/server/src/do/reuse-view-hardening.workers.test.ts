import { startCapture } from '@cupboard/logger/testing';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheNameSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import {
	reuseViewNameSchema,
	reuseViewSetBodySchema
} from '@cupboard/protocol/reuse-views';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';
import { rootLogger } from '../observability/logging.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	fixtureWorkerServer,
	flakyD1,
	type FlakyD1Plan,
	flakyR2,
	readFetch,
	resetTestServer
} from '../test-support.ts';

import { ServerContext } from './context.ts';
import { ReuseViewAdminService } from './reuse-view-admin-service.ts';
import { ReuseViewLookupService } from './reuse-view-lookup-service.ts';
import {
	committedPath,
	insertUnbackedRow,
	lookupPath,
	setView
} from './reuse-view-read.test-support.ts';
import { type CupboardServer } from './server.ts';

const viewName = reuseViewNameSchema.parse('reuse');
const pr1Cache = cacheNameSchema.parse('pr-1');
const pr2Cache = cacheNameSchema.parse('pr-2');

// Drives a lookup on the fixture Worker's Durable Object through a service
// whose shared-fact reads go through the given D1 plan, so a test can fail
// them or interleave a mutation at the exact point the lookup sits between
// its two gate entries.
async function lookupWithPlan(
	storePathHash: string,
	plan: (instance: CupboardServer) => FlakyD1Plan
): Promise<NarInfo | undefined> {
	const parsed = storePathHashSchema.parse(storePathHash);

	return runInDurableObject(fixtureWorkerServer(), (instance, state) => {
		const context = new ServerContext(state, {
			...instance.context.env,
			CUPBOARD_DB: flakyD1(instance.context.env.CUPBOARD_DB, plan(instance))
		});
		const service = new ReuseViewLookupService(context);

		return service.lookup(rootLogger(), viewName, parsed);
	});
}

// A between-gates seam: the blob_ref edge read is the first shared-fact query
// the lookup issues after leaving the first gate, so a mutation fired on its
// first match lands after the snapshot and before the revalidation.
function betweenGates(mutate: () => void): FlakyD1Plan {
	let isFired = false;

	return {
		failures: 0,
		matches: (query) => query.includes('blob_ref'),
		onMatch: () => {
			if (isFired) {
				return;
			}

			isFired = true;
			mutate();
		}
	};
}

const requestLineSchema = z.object({
	path: z.string(),
	status: z.number(),
	rowsRead: z.number()
});

// The row cost the Durable Object logged for one reuse lookup request.
async function lookupCost(storePathHash: string): Promise<{
	status: number;
	rowsRead: number;
}> {
	const capture = startCapture();
	let status: number;

	try {
		const response = await readFetch(lookupPath(storePathHash));
		status = response.status;
	} finally {
		capture.stop();
	}

	const line = capture.logs
		.filter((entry) => entry.message === 'request finished')
		.map((entry) => requestLineSchema.parse(entry.properties))
		.find((entry) => entry.path.endsWith(`${storePathHash}.narinfo`));

	return { status, rowsRead: line?.rowsRead ?? -1 };
}

// Two-character store-path-hash prefixes drawn from the nix base32 alphabet,
// so generated test hashes always parse.
const hashAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

function generatedHash(index: number): string {
	const prefix =
		(hashAlphabet[Math.floor(index / hashAlphabet.length)] ?? '0') +
		(hashAlphabet[index % hashAlphabet.length] ?? '0');

	return prefix.repeat(16);
}

describe('reuse-view lookup hardening', () => {
	beforeEach(resetTestServer);

	it('misses when a recommit lands between the gates', async () => {
		const path = await committedPath('harden-recommit', 'pr-1', {
			storePathHash: 'a1'.repeat(16)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);
		const parsed = storePathHashSchema.parse(path.storePathHash);

		const served = await lookupWithPlan(path.storePathHash, (instance) =>
			betweenGates(() => {
				instance.context.db
					.update(schema.narInfos)
					.set({ generation: sql`${schema.narInfos.generation} + 1` })
					.where(eq(schema.narInfos.storePathHash, parsed))
					.run();
			})
		);

		expect(served).toBeUndefined();
	});

	it('serves when a discarded sibling row is deleted between the gates', async () => {
		const path = await committedPath('harden-discarded', 'pr-1', {
			storePathHash: 'f1'.repeat(16)
		});
		const parsed = storePathHashSchema.parse(path.storePathHash);
		await insertUnbackedRow('pr-2', path.storePathHash, path.narHash);
		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		// The pr-2 row was discarded off-gate (it has no committed edge), so
		// its reclamation between the gates must not fail the verified answer.
		const served = await lookupWithPlan(path.storePathHash, (instance) =>
			betweenGates(() => {
				instance.context.db
					.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, pr2Cache),
							eq(schema.narInfos.storePathHash, parsed)
						)
					)
					.run();
			})
		);

		expect(served?.narHash.toString()).toBe(path.narHash);
	});

	it('misses when the view is deleted and recreated between the gates', async () => {
		const path = await committedPath('harden-recreate', 'pr-1', {
			storePathHash: 'b1'.repeat(16)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);
		const body = reuseViewSetBodySchema.parse({
			selectors: [{ kind: 'exact', pattern: 'pr-1' }]
		});

		const served = await lookupWithPlan(path.storePathHash, (instance) => {
			const admin = new ReuseViewAdminService(instance.context);

			return betweenGates(() => {
				admin.removeView(viewName);
				admin.setView(viewName, body);
			});
		});

		expect(served).toBeUndefined();
	});

	it('misses when the view definition is replaced between the gates', async () => {
		const path = await committedPath('harden-redefine', 'pr-1', {
			storePathHash: 'c1'.repeat(16)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);
		const body = reuseViewSetBodySchema.parse({
			selectors: [{ kind: 'prefix', pattern: 'pr-' }]
		});

		const served = await lookupWithPlan(path.storePathHash, (instance) => {
			const admin = new ReuseViewAdminService(instance.context);

			return betweenGates(() => {
				admin.setView(viewName, body);
			});
		});

		expect(served).toBeUndefined();
	});

	it('serves through one transient shared-fact fault', async () => {
		const path = await committedPath('harden-transient', 'pr-1', {
			storePathHash: 'd1'.repeat(16)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);

		const served = await lookupWithPlan(path.storePathHash, () => ({
			failures: 1,
			matches: (query) => query.includes('blob_ref')
		}));

		expect({
			narHash: served?.narHash.toString(),
			url: served?.url
		}).toStrictEqual({
			narHash: path.narHash,
			url: `../../${narObjectKey(nixSha256HashSchema.parse(path.narHash))}`
		});
	});

	it('refuses retryably under a persistent shared-fact fault', async () => {
		const path = await committedPath('harden-persistent', 'pr-1', {
			storePathHash: 'f1'.repeat(16)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);

		await expect(
			lookupWithPlan(path.storePathHash, () => ({
				failures: 4,
				matches: (query) => query.includes('blob_ref')
			}))
		).rejects.toBeInstanceOf(SharedFactsUnavailableError);
	});

	it('answers a canonical-object probe fault as a retryable 503, not a miss', async () => {
		const path = await committedPath('harden-probe', 'pr-1', {
			storePathHash: 'g1'.repeat(16)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			instance.context.env = {
				...instance.context.env,
				BLOBS: flakyR2(instance.context.env.BLOBS, { failures: 1 })
			};
		});

		const refused = await readFetch(lookupPath(path.storePathHash));
		const recovered = await readFetch(lookupPath(path.storePathHash));

		expect({
			refusedStatus: refused.status,
			retryAfter: refused.headers.get('retry-after'),
			cacheControl: refused.headers.get('cache-control'),
			recoveredStatus: recovered.status
		}).toStrictEqual({
			refusedStatus: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5',
			cacheControl: 'no-store',
			recoveredStatus: StatusCodes.OK
		});
	});

	// A non-retryable fault must honour the view's always-no-store contract
	// too: a corrupt stored row surfaces as a server error, and a shared cache
	// that stored it would keep serving the error long after the row is
	// repaired or recommitted.
	it('answers a corrupt stored row as an uncached server error', async () => {
		const path = await committedPath('harden-corrupt', 'pr-1', {
			storePathHash: 'h1'.repeat(16)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			instance.context.db
				.update(schema.narInfos)
				.set({ sigsJson: '{"not":"a signature list"}' })
				.where(
					eq(
						schema.narInfos.storePathHash,
						storePathHashSchema.parse(path.storePathHash)
					)
				)
				.run();
		});

		const response = await readFetch(lookupPath(path.storePathHash));

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			cacheControl: 'no-store'
		});
	});

	// A stale-generation `blob_ref` edge outlives its narinfo row until the
	// async deletion drains it, so a recommit-heavy path can leave a backlog of
	// them behind for the same (tenant, cache, store_path_hash). The edge query
	// must key on the exact candidate generation, not just the candidate cache,
	// or such a backlog inflates the read past the candidate bound.
	it('serves correctly and reads exactly one edge row per candidate despite an undrained stale-generation backlog', async () => {
		const path = await committedPath('harden-backlog', 'pr-1', {
			storePathHash: 'i1'.repeat(16)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);
		const parsedHash = storePathHashSchema.parse(path.storePathHash);
		const parsedNarHash = nixSha256HashSchema.parse(path.narHash);

		const live = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db
				.select({ generation: schema.narInfos.generation })
				.from(schema.narInfos)
				.where(eq(schema.narInfos.storePathHash, parsedHash))
				.get()
		);

		if (live === undefined) {
			throw new Error('the committed path must have a narinfo row');
		}

		// A backlog of stale-generation edges sharing this candidate's (tenant,
		// cache, store_path_hash) but none of its generations, the shape an
		// undrained deletion backlog leaves behind.
		const staleCount = 20;
		const d1 = drizzleD1(env.CUPBOARD_DB, {
			schema: { blobReference: d1Schema.blobReference }
		});
		await d1
			.insert(d1Schema.blobReference)
			.values(
				Array.from({ length: staleCount }, (_, index) => ({
					tenant: fixtureTenant,
					cache: pr1Cache,
					storePathHash: parsedHash,
					generation: narInfoGenerationSchema.parse(
						live.generation + index + 1
					),
					narHash: parsedNarHash
				}))
			)
			.run();

		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let edgeRowsRead = 0;
		const batches = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation(async (statements) => {
				const results = await originalBatch(statements);
				edgeRowsRead += results.reduce(
					(sum, result) => sum + result.results.length,
					0
				);

				return results;
			});

		try {
			const response = await readFetch(lookupPath(path.storePathHash));
			const narInfo = NarInfo.parse(await response.text());

			expect({
				status: response.status,
				narHash: narInfo.narHash.toString(),
				batchCalls: batches.mock.calls.length,
				edgeRowsRead
			}).toStrictEqual({
				status: StatusCodes.OK,
				narHash: path.narHash,
				batchCalls: 1,
				edgeRowsRead: 1
			});
		} finally {
			batches.mockRestore();
		}
	});

	it('range-scans prefix selectors on the composite narinfo index', async () => {
		const planRowSchema = z.object({ detail: z.string() });
		const hash = 'h1'.repeat(16);
		const rows = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db.all(
				sql`EXPLAIN QUERY PLAN SELECT cache FROM narinfo WHERE store_path_hash = ${hash} AND cache >= ${'pr-'} AND cache < ${'pr.'}`
			)
		);
		const details = z.array(planRowSchema).parse(rows);

		expect(
			details.some((row) =>
				row.detail.includes('narinfo_store_path_hash_cache_idx')
			)
		).toBe(true);
	});

	it('reads a bounded row count that does not scale with unrelated rows', async () => {
		const path = await committedPath('harden-cost-a', 'pr-1', {
			storePathHash: 'j1'.repeat(16)
		});
		await committedPath('harden-cost-a', 'pr-2', {
			storePathHash: 'j1'.repeat(16)
		});
		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		const baseline = await lookupCost(path.storePathHash);

		// Unrelated rows: other hashes in a matching cache, and the same hash in
		// a cache outside the selector's range. Neither may add to the read.
		const narHash = nixSha256HashSchema.parse(path.narHash);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const unrelated = Array.from({ length: 200 }, (_, index) => ({
				cache: pr1Cache,
				storePathHash: storePathHashSchema.parse(generatedHash(index)),
				storePath: storePathSchema.parse(
					`/nix/store/${generatedHash(index)}-other`
				),
				narHash,
				narSize: 10,
				referencesJson: '[]',
				sigsJson: '[]',
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
			}));

			// The Durable Object's SQLite binds at most ~100 variables per
			// statement, so the seed rows go in during small batches.
			for (let start = 0; start < unrelated.length; start += 10) {
				instance.context.db
					.insert(schema.narInfos)
					.values(unrelated.slice(start, start + 10))
					.run();
			}
			instance.context.db
				.insert(schema.narInfos)
				.values({
					cache: cacheNameSchema.parse('zz-outside'),
					storePathHash: storePathHashSchema.parse(path.storePathHash),
					storePath: storePathSchema.parse(path.storePath),
					narHash,
					narSize: 10,
					referencesJson: '[]',
					sigsJson: '[]',
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
				})
				.run();
		});

		const withBacklog = await lookupCost(path.storePathHash);

		// The one extra read is the range scan touching its boundary row (the
		// same hash in the out-of-range cache); the two hundred same-cache rows
		// add nothing. Exact pins, so a constant regression cannot hide behind
		// an inequality.
		expect({ baseline, withBacklog }).toStrictEqual({
			baseline: { status: StatusCodes.OK, rowsRead: 9 },
			withBacklog: { status: StatusCodes.OK, rowsRead: 10 }
		});
	});
});
