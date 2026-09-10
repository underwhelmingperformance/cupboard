import { startCapture } from '@cupboard/logger/testing';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
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

import * as schema from '../db/schema.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { cacheMigrationColumns } from '../migration/cache-access.ts';
import * as migrationSchema from '../migration/cache-access-schema.ts';
import { rootLogger } from '../observability/logging.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentNarObjectKey,
	fixtureWorkerServer,
	flakyD1,
	type FlakyD1Plan,
	flakyR2,
	namedCache,
	readFetch,
	resetTestServer,
	resolvedCache,
	workerFetch
} from '../test-support.ts';

import { chunkByStatementParameters } from './bulk.ts';
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
const pr1Cache = namedCache('pr-1');
const pr2Cache = namedCache('pr-2');

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

		return service.lookup(rootLogger(), viewName, 'public', parsed);
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
		const path = await committedPath('harden-recommit', pr1Cache, {
			storePathHash: 'a1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
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
		const path = await committedPath('harden-discarded', pr1Cache, {
			storePathHash: 'f1'.repeat(16),
			access: 'public'
		});
		const parsed = storePathHashSchema.parse(path.storePathHash);
		await insertUnbackedRow(pr2Cache, path.storePathHash, path.narHash);
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);

		// The pr-2 row has no committed edge. Its removal between the gates must
		// not invalidate the surviving candidate.
		const served = await lookupWithPlan(path.storePathHash, (instance) =>
			betweenGates(() => {
				const cache = resolvedCache(instance.context, pr2Cache);

				instance.context.db
					.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, parsed)
						)
					)
					.run();
			})
		);

		expect(served?.narHash.toString()).toBe(path.narHash);
	});

	it('misses when the view is deleted and recreated between the gates', async () => {
		const path = await committedPath('harden-recreate', pr1Cache, {
			storePathHash: 'b1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
		const body = reuseViewSetBodySchema.parse({
			access: 'public',
			selectors: [{ kind: 'named', name: 'pr-1' }]
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
		const path = await committedPath('harden-redefine', pr1Cache, {
			storePathHash: 'c1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
		const body = reuseViewSetBodySchema.parse({
			access: 'public',
			selectors: [{ kind: 'prefix', prefix: 'pr-' }]
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
		const path = await committedPath('harden-transient', pr1Cache, {
			storePathHash: 'd1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);

		const served = await lookupWithPlan(path.storePathHash, () => ({
			failures: 1,
			matches: (query) => query.includes('blob_ref')
		}));

		expect({
			narHash: served?.narHash.toString(),
			url: served?.url
		}).toStrictEqual({
			narHash: path.narHash,
			url: await currentNarObjectKey(nixSha256HashSchema.parse(path.narHash))
		});
	});

	it('refuses retryably under a persistent shared-fact fault', async () => {
		const path = await committedPath('harden-persistent', pr1Cache, {
			storePathHash: 'f1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);

		await expect(
			lookupWithPlan(path.storePathHash, () => ({
				failures: 4,
				matches: (query) => query.includes('blob_ref')
			}))
		).rejects.toBeInstanceOf(SharedFactsUnavailableError);
	});

	it('returns a retryable 503 when the canonical-object probe fails', async () => {
		const path = await committedPath('harden-probe', pr1Cache, {
			storePathHash: 'g1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
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
	it('returns an uncached server error for a corrupt stored row', async () => {
		const path = await committedPath('harden-corrupt', pr1Cache, {
			storePathHash: 'h1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
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
		const path = await committedPath('harden-backlog', pr1Cache, {
			storePathHash: 'i1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
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

		// Use the same tenant, cache, and path hash but older generations. This is
		// the shape left by an undrained deletion backlog.
		const staleCount = 20;
		const d1 = drizzleD1(env.CUPBOARD_DB, {
			schema: { blobReferences: migrationSchema.blobReferences }
		});
		const staleReferences = Array.from({ length: staleCount }, (_, index) => ({
			tenant: fixtureTenant,
			...cacheMigrationColumns(pr1Cache, 'public'),
			storePathHash: parsedHash,
			generation: narInfoGenerationSchema.parse(live.generation + index + 1),
			narHash: parsedNarHash
		}));

		const referenceChunks = chunkByStatementParameters(
			staleReferences,
			(references) =>
				d1.insert(migrationSchema.blobReferences).values([...references])
		);

		for (const references of referenceChunks) {
			await d1
				.insert(migrationSchema.blobReferences)
				.values([...references])
				.run();
		}

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
			const response = await workerFetch(lookupPath(path.storePathHash));
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

	it('uses the composite narinfo index for prefix selectors', async () => {
		const planRowSchema = z.object({ detail: z.string() });
		const hash = 'h1'.repeat(16);
		const rows = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			instance.context.db.all(
				sql`EXPLAIN QUERY PLAN
					SELECT narinfo.cache_id
					FROM narinfo
					INNER JOIN cache_identity ON cache_identity.id = narinfo.cache_id
					WHERE narinfo.store_path_hash = ${hash}
						AND cache_identity.kind = 'named'
						AND cache_identity.name >= ${'pr-'}
						AND cache_identity.name < ${'pr.'}`
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
		const path = await committedPath('harden-cost-a', pr1Cache, {
			storePathHash: 'j1'.repeat(16),
			access: 'public'
		});
		await committedPath('harden-cost-a', pr2Cache, {
			storePathHash: 'j1'.repeat(16),
			access: 'public'
		});
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);

		const baseline = await lookupCost(path.storePathHash);

		const narHash = nixSha256HashSchema.parse(path.narHash);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const pr1 = resolvedCache(instance.context, pr1Cache);
			const outside = instance.context.cacheRepository.resolveOrCreate(
				namedCache('zz-outside'),
				'public'
			);
			const unrelated = Array.from({ length: 200 }, (_, index) => ({
				cacheId: pr1.id,
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

			for (let start = 0; start < unrelated.length; start += 10) {
				instance.context.db
					.insert(schema.narInfos)
					.values(unrelated.slice(start, start + 10))
					.run();
			}
			instance.context.db
				.insert(schema.narInfos)
				.values({
					cacheId: outside.id,
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

		expect({ baseline, withBacklog }).toStrictEqual({
			baseline: { status: StatusCodes.OK, rowsRead: 17 },
			withBacklog: { status: StatusCodes.OK, rowsRead: 19 }
		});
	});
});
