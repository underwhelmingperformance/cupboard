import { startCapture } from '@cupboard/logger/testing';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheNameSchema,
	DEFAULT_CACHE_SELECTOR,
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	cacheAvailabilityResponseSchema,
	reuseViewAvailabilityMaxPaths
} from '@cupboard/protocol/cache-availability';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { SubrequestSliceExceededError } from '../errors.ts';
import { rootLogger } from '../observability/logging.ts';
import { reuseViewAvailabilityChunkSize } from '../routing/chunked-availability.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	currentNarObjectKey,
	fixtureWorkerServer,
	provisionFixtureTenant,
	readFetch,
	resetTestServer
} from '../test-support.ts';

import {
	reuseDistinctNarLimit,
	ReuseViewLookupService,
	reuseViewProbeD1CallsPerChunk
} from './reuse-view-lookup-service.ts';
import {
	committedPath,
	insertAgreeingCopy,
	insertBackedRow,
	insertUnbackedRow,
	lookupPath,
	type ReuseSelector,
	setView
} from './reuse-view-read.test-support.ts';
import { storedSignaturesSchema } from './signing-keys.ts';
import { withSubrequestSlice } from './subrequest-slice.ts';

function sharedFacts() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

// The properties a lookup's own log events carry, without the request context
// the logger adds to every event.
const reuseLookupEventSchema = z.object({
	view: z.string(),
	storePathHash: z.string(),
	limit: z.number().optional(),
	caches: z.array(z.string()).optional()
});

const requestFinishedSchema = z.object({ path: z.string() });

function generatedMissingHashes(count: number): string[] {
	return Array.from({ length: count }, (_, index) =>
		storePathHashSchema.parse(String(index + 100).padStart(32, '0'))
	);
}

describe('reuse-view narinfo lookup', () => {
	beforeEach(resetTestServer);

	// A view page may cost `reuseDistinctNarLimit` heads per hash at worst, and
	// the Worker sends it to the object in chunks that fit one invocation's
	// slice at that cost. A page one hash over a chunk takes two object
	// requests and is answered completely, in request order.
	it('returns present and missing hashes through the bulk availability route', async () => {
		const present = await committedPath('reuse-bulk', 'pr-1');
		const missing = generatedMissingHashes(reuseViewAvailabilityMaxPaths - 1);
		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		const capture = startCapture();
		let status: number;
		let cacheControl: string | null;
		let body: unknown;

		try {
			const response = await readFetch('/reuse/reuse/api/v1/missing-paths', {
				body: JSON.stringify({
					storePathHashes: [present.storePathHash, ...missing]
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});
			status = response.status;
			cacheControl = response.headers.get('cache-control');
			body = cacheAvailabilityResponseSchema.parse(await response.json());
		} finally {
			capture.stop();
		}

		const objectRequests = capture.logs.filter(
			(entry) =>
				entry.message === 'request finished' &&
				requestFinishedSchema.parse(entry.properties).path ===
					'/reuse/reuse/api/v1/missing-paths'
		).length;

		expect({ status, cacheControl, body, objectRequests }).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-store',
			body: { missingStorePathHashes: missing },
			objectRequests: Math.ceil(
				reuseViewAvailabilityMaxPaths / reuseViewAvailabilityChunkSize
			)
		});
	});

	// A chunk is sized so that its worst case fits the object's slice after
	// the probe's D1 reads; a chunk that does not fit is a sizing defect, and
	// the object refuses it instead of running into the platform's ceiling.
	it('refuses a chunk whose worst-case heads exceed the subrequest slice', async () => {
		const path = await committedPath('reuse-slice', 'pr-1', {
			storePathHash: 'a'.repeat(32)
		});
		await committedPath('reuse-slice-other', 'pr-2', {
			storePathHash: path.storePathHash,
			name: 'divergent'
		});
		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		let refusal: unknown;

		try {
			await runInDurableObject(fixtureWorkerServer(), (instance) =>
				withSubrequestSlice(
					() =>
						asOneInvocation(() =>
							new ReuseViewLookupService(
								instance.context
							).missingStorePathHashes(
								rootLogger(),
								reuseViewNameSchema.parse('reuse'),
								[storePathHashSchema.parse(path.storePathHash)]
							)
						),
					{ subrequests: reuseViewProbeD1CallsPerChunk + 1, reserve: 0 }
				)
			);
		} catch (error) {
			refusal = error;
		}

		expect({
			isRefused: refusal instanceof SubrequestSliceExceededError,
			subrequests:
				refusal instanceof SubrequestSliceExceededError
					? refusal.subrequests
					: undefined
		}).toStrictEqual({ isRefused: true, subrequests: 2 });
	});

	it.each([
		{
			label: 'an exact selector',
			selectors: [{ kind: 'exact', pattern: 'pr-1' }]
		},
		{
			label: 'the default-cache exact selector',
			selectors: [{ kind: 'exact', pattern: '_default' }],
			cache: DEFAULT_CACHE_SELECTOR
		},
		{
			label: 'a prefix selector',
			selectors: [{ kind: 'prefix', pattern: 'pr-' }]
		},
		{ label: 'the empty prefix', selectors: [{ kind: 'prefix', pattern: '' }] }
	] as const satisfies readonly {
		label: string;
		selectors: readonly ReuseSelector[];
		cache?: string;
	}[])(
		'serves a committed candidate through $label',
		async ({ selectors, cache }) => {
			const path = await committedPath('reuse-hit', cache ?? 'pr-1');
			await setView(selectors);

			const response = await readFetch(lookupPath(path.storePathHash));
			const narInfo = NarInfo.parse(await response.text());

			expect({
				status: response.status,
				contentType: response.headers.get('content-type'),
				cacheControl: response.headers.get('cache-control'),
				storePath: narInfo.storePath.value,
				url: narInfo.url,
				narHash: narInfo.narHash.toString(),
				hasSignature: narInfo.sigs.length > 0
			}).toStrictEqual({
				status: StatusCodes.OK,
				contentType: 'text/x-nix-narinfo; charset=utf-8',
				cacheControl: 'no-store',
				storePath: path.storePath,
				url: `../../${await currentNarObjectKey(
					nixSha256HashSchema.parse(path.narHash)
				)}`,
				narHash: path.narHash,
				hasSignature: true
			});
		}
	);

	it.each([
		{
			label: 'the empty prefix does not select a private cache',
			cache: 'private/builds',
			storePathHash: '6'.repeat(32),
			isServed: false
		},
		{
			label: 'a matching prefix does not select a private cache',
			cache: 'private/builds',
			storePathHash: '7'.repeat(32),
			prefix: 'p',
			isServed: false
		},
		{
			label: 'the empty prefix selects a public cache called private',
			cache: 'private',
			storePathHash: '8'.repeat(32),
			isServed: true
		},
		{
			label: 'a matching prefix selects a public cache',
			cache: 'pr-9',
			storePathHash: '9'.repeat(32),
			prefix: 'p',
			isServed: true
		}
	])('$label', async ({ cache, storePathHash, prefix = '', isServed }) => {
		const committed = await committedPath('reuse-private-source', 'source', {
			storePathHash: '5'.repeat(32)
		});
		await insertBackedRow(cache, storePathHash, committed.storePathHash);
		await setView([{ kind: 'prefix', pattern: prefix }]);

		const narInfo = await readFetch(lookupPath(storePathHash));
		const availability = await readFetch('/reuse/reuse/api/v1/missing-paths', {
			body: JSON.stringify({ storePathHashes: [storePathHash] }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		const body = cacheAvailabilityResponseSchema.parse(
			await availability.json()
		);

		expect({
			narInfoStatus: narInfo.status,
			availabilityStatus: availability.status,
			body
		}).toStrictEqual({
			narInfoStatus: isServed ? StatusCodes.OK : StatusCodes.NOT_FOUND,
			availabilityStatus: StatusCodes.OK,
			body: { missingStorePathHashes: isServed ? [] : [storePathHash] }
		});
	});

	it('answers a miss no-store when no selected cache holds the hash', async () => {
		const path = await committedPath('reuse-unselected', 'other', {
			storePathHash: '2'.repeat(32)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);

		const response = await readFetch(lookupPath(path.storePathHash));

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			cacheControl: 'no-store'
		});
	});

	it('404s an unknown view and an invalid view name, no-store', async () => {
		const path = await committedPath('reuse-no-view', 'pr-1', {
			storePathHash: '3'.repeat(32)
		});

		const unknown = await readFetch(lookupPath(path.storePathHash, 'absent'));
		const invalid = await readFetch(lookupPath(path.storePathHash, 'NOT%20OK'));

		expect({
			unknown: unknown.status,
			unknownCacheControl: unknown.headers.get('cache-control'),
			invalid: invalid.status,
			invalidCacheControl: invalid.headers.get('cache-control')
		}).toStrictEqual({
			unknown: StatusCodes.NOT_FOUND,
			unknownCacheControl: 'no-store',
			invalid: StatusCodes.NOT_FOUND,
			invalidCacheControl: 'no-store'
		});
	});

	// Every copy the view selects is compared rather than truncated, so the
	// number of caches holding a path does not affect whether it is served.
	it('serves a path that many caches of the view hold', async () => {
		const copies = 40;
		const path = await committedPath('reuse-wide', 'pr-0', {
			storePathHash: '4'.repeat(32)
		});

		for (let index = 1; index <= copies; index += 1) {
			await insertAgreeingCopy(`pr-${String(index)}`, path.storePathHash);
		}

		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		const response = await readFetch(lookupPath(path.storePathHash));
		const narInfo = NarInfo.parse(await response.text());
		const availability = await readFetch('/reuse/reuse/api/v1/missing-paths', {
			body: JSON.stringify({ storePathHashes: [path.storePathHash] }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		const body = cacheAvailabilityResponseSchema.parse(
			await availability.json()
		);

		expect({
			narInfoStatus: response.status,
			narHash: narInfo.narHash.toString(),
			availabilityStatus: availability.status,
			body
		}).toStrictEqual({
			narInfoStatus: StatusCodes.OK,
			narHash: path.narHash,
			availabilityStatus: StatusCodes.OK,
			body: { missingStorePathHashes: [] }
		});
	});

	// The comparison is what makes serving a wide view safe, so it has to reach
	// every copy. One cache out of many that disagrees still refuses the path.
	it('answers a wide view with one disagreeing copy as a miss', async () => {
		const agreeing = 40;
		const path = await committedPath('reuse-wide-conflict', 'pr-0', {
			storePathHash: '7'.repeat(32)
		});

		for (let index = 1; index <= agreeing; index += 1) {
			await insertAgreeingCopy(`pr-${String(index)}`, path.storePathHash);
		}

		await committedPath('reuse-wide-other', `pr-${String(agreeing + 1)}`, {
			storePathHash: path.storePathHash,
			name: 'divergent'
		});
		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		const response = await readFetch(lookupPath(path.storePathHash));

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	// The probe heads one NAR object for each distinct NAR among the copies. A
	// path with more distinct NARs than the limit is refused before the probe:
	// its copies disagree, so the comparison would refuse it in any case.
	it('refuses a path over the distinct NAR limit before the probe', async () => {
		const copies = reuseDistinctNarLimit + 1;
		const storePathHash = '6'.repeat(32);

		for (let index = 1; index <= copies; index += 1) {
			await committedPath(
				`reuse-distinct-${String(index)}`,
				`pr-${String(index)}`,
				{
					storePathHash,
					name: `copy-${String(index)}`
				}
			);
		}

		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		const heads = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			vi.spyOn(instance.context.env.BLOBS, 'head')
		);
		const capture = startCapture();
		let status: number;
		let narHeads: number;

		try {
			const response = await readFetch(lookupPath(storePathHash));
			status = response.status;
			narHeads = heads.mock.calls.filter(([key]) =>
				key.startsWith('nar/')
			).length;
		} finally {
			capture.stop();
			heads.mockRestore();
		}

		const events = capture.logs
			.filter((entry) => entry.message.startsWith('reuse lookup'))
			.map((entry) => ({
				message: entry.message,
				...reuseLookupEventSchema.parse(entry.properties)
			}));

		expect({ status, narHeads, events }).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			narHeads: 0,
			events: [
				{
					message: 'reuse lookup exceeded the distinct NAR limit',
					view: 'reuse',
					storePathHash,
					limit: reuseDistinctNarLimit
				}
			]
		});
	});

	it('answers conflicting candidates as a miss', async () => {
		const first = await committedPath('reuse-conflict-a', 'pr-1', {
			storePathHash: 'c'.repeat(32),
			name: 'first'
		});
		await committedPath('reuse-conflict-b', 'pr-2', {
			storePathHash: 'c'.repeat(32),
			name: 'first'
		});
		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		const response = await readFetch(lookupPath(first.storePathHash));

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('merges the signature sets of identical candidates deterministically', async () => {
		const extraSignature = `other-1:${btoa('another signature')}`;
		const path = await committedPath('reuse-merge', 'pr-1', {
			storePathHash: '5'.repeat(32)
		});
		await committedPath('reuse-merge', 'pr-2', {
			storePathHash: '5'.repeat(32)
		});
		await setView([{ kind: 'prefix', pattern: 'pr-' }]);

		const baselineResponse = await readFetch(lookupPath(path.storePathHash));
		const baseline = NarInfo.parse(await baselineResponse.text());
		const storePathHash = storePathHashSchema.parse(path.storePathHash);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const target = and(
				eq(schema.narInfos.cache, cacheNameSchema.parse('pr-2')),
				eq(schema.narInfos.storePathHash, storePathHash)
			);
			const row = instance.context.db
				.select({ sigsJson: schema.narInfos.sigsJson })
				.from(schema.narInfos)
				.where(target)
				.get();
			const storedJson: unknown = JSON.parse(row?.sigsJson ?? '[]');
			const stored = storedSignaturesSchema.parse(storedJson);
			instance.context.db
				.update(schema.narInfos)
				.set({ sigsJson: JSON.stringify([...stored, extraSignature]) })
				.where(target)
				.run();
		});

		const mergedResponse = await readFetch(lookupPath(path.storePathHash));
		const merged = NarInfo.parse(await mergedResponse.text());

		expect(merged.sigs).toStrictEqual(
			[...baseline.sigs, extraSignature].toSorted(byCodeUnit)
		);
	});

	it('rejects a local row with no committed edge behind it', async () => {
		await setView([{ kind: 'prefix', pattern: 'pr-' }]);
		const storePathHash = 'd'.repeat(32);
		await insertUnbackedRow('pr-1', storePathHash, `sha256:${'g'.repeat(52)}`);

		const response = await readFetch(lookupPath(storePathHash));

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it.each([
		{
			label: 'the tenant ownership fact is gone',
			seed: 'reuse-unbacked-ownership',
			storePathHash: '6'.repeat(32),
			remove: async (narHash: string) => {
				const parsed = nixSha256HashSchema.parse(narHash);
				await sharedFacts()
					.delete(d1Schema.tenantBlob)
					.where(
						and(
							eq(d1Schema.tenantBlob.tenant, fixtureTenant),
							eq(d1Schema.tenantBlob.narHash, parsed)
						)
					)
					.run();
			}
		},
		{
			label: 'the shared blob fact is gone',
			seed: 'reuse-unbacked-fact',
			storePathHash: '7'.repeat(32),
			remove: async (narHash: string) => {
				await sharedFacts()
					.delete(d1Schema.blobState)
					.where(
						eq(d1Schema.blobState.narHash, nixSha256HashSchema.parse(narHash))
					)
					.run();
			}
		},
		{
			label: 'the canonical object is gone',
			seed: 'reuse-unbacked-object',
			storePathHash: '8'.repeat(32),
			remove: async (narHash: string) => {
				await env.BLOBS.delete(
					await currentNarObjectKey(nixSha256HashSchema.parse(narHash))
				);
			}
		}
	])('misses when $label', async ({ seed, storePathHash, remove }) => {
		const path = await committedPath(seed, 'pr-1', { storePathHash });
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);
		await remove(path.narHash);

		const response = await readFetch(lookupPath(path.storePathHash));

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('gates a private tenant lookup behind the read credential', async () => {
		const path = await committedPath('reuse-private', 'pr-1', {
			storePathHash: '9'.repeat(32)
		});
		await setView([{ kind: 'exact', pattern: 'pr-1' }]);
		await provisionFixtureTenant({
			readMode: 'private',
			read: { user: 'alice', password: 'secret' }
		});

		const denied = await readFetch(lookupPath(path.storePathHash));
		const served = await readFetch(lookupPath(path.storePathHash), {
			headers: { authorization: `Basic ${btoa('alice:secret')}` }
		});
		const availabilityRequest = {
			body: JSON.stringify({ storePathHashes: [path.storePathHash] }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		};
		const bulkDenied = await readFetch(
			'/reuse/reuse/api/v1/missing-paths',
			availabilityRequest
		);
		const bulkServed = await readFetch('/reuse/reuse/api/v1/missing-paths', {
			...availabilityRequest,
			headers: {
				...availabilityRequest.headers,
				authorization: `Basic ${btoa('alice:secret')}`
			}
		});

		expect({
			denied: denied.status,
			served: served.status,
			bulkDenied: bulkDenied.status,
			bulkServed: bulkServed.status
		}).toStrictEqual({
			denied: StatusCodes.UNAUTHORIZED,
			served: StatusCodes.OK,
			bulkDenied: StatusCodes.UNAUTHORIZED,
			bulkServed: StatusCodes.OK
		});
	});
});
