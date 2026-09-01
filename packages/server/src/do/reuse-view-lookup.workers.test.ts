import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheAccessMode,
	type CacheScope,
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	cacheAvailabilityResponseSchema,
	reuseViewAvailabilityMaxPaths
} from '@cupboard/protocol/cache-availability';
import {
	managedCacheGroupIdSchema,
	managedPolicyIdSchema,
	managedPolicyRevisionSchema
} from '@cupboard/protocol/managed-caches';
import { type ReuseViewSelectorInput } from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentNarObjectKey,
	defaultCache,
	fixtureWorkerServer,
	namedCache,
	provisionFixtureTenant,
	readFetch,
	resetTestServer,
	resolvedCache
} from '../test-support.ts';

import { reuseCandidateLimit } from './reuse-view-lookup-service.ts';
import {
	committedPath,
	insertBackedRow,
	insertUnbackedRow,
	lookupPath,
	setView
} from './reuse-view-read.test-support.ts';
import { storedSignaturesSchema } from './signing-keys.ts';

function sharedFacts() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

describe('reuse-view narinfo lookup', () => {
	beforeEach(resetTestServer);

	it('returns present and missing hashes through the bulk availability route', async () => {
		const present = await committedPath('reuse-bulk', namedCache('pr-1'));
		const missing = Array.from(
			{ length: reuseViewAvailabilityMaxPaths - 1 },
			(_, index) =>
				storePathHashSchema.parse(String(index + 100).padStart(32, '0'))
		);
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);

		const response = await readFetch('/reuse/reuse/api/v1/missing-paths', {
			body: JSON.stringify({
				storePathHashes: [present.storePathHash, ...missing]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		const body = cacheAvailabilityResponseSchema.parse(await response.json());

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			body
		}).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-store',
			body: { missingStorePathHashes: missing }
		});
	});

	const selectorCases: {
		readonly label: string;
		readonly selectors: ReuseViewSelectorInput[];
		readonly cache?: CacheScope;
	}[] = [
		{
			label: 'a named selector',
			selectors: [{ kind: 'named', name: 'pr-1' }]
		},
		{
			label: 'the default-cache selector',
			selectors: [{ kind: 'default' }],
			cache: defaultCache()
		},
		{
			label: 'a prefix selector',
			selectors: [{ kind: 'prefix', prefix: 'pr-' }]
		},
		{ label: 'the all-caches selector', selectors: [{ kind: 'all' }] }
	];

	it.each(selectorCases)(
		'serves a committed candidate through $label',
		async ({ selectors, cache }) => {
			const path = await committedPath(
				'reuse-hit',
				cache ?? namedCache('pr-1')
			);
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
				url: await currentNarObjectKey(nixSha256HashSchema.parse(path.narHash)),
				narHash: path.narHash,
				hasSignature: true
			});
		}
	);

	it('excludes managed caches from all selectors in both lookup modes', async () => {
		const cache = namedCache('managed-pr-1');
		const path = await committedPath('reuse-managed-all', cache);
		await setView([{ kind: 'all' }]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const policyId = managedPolicyIdSchema.parse(crypto.randomUUID());
			const groupId = managedCacheGroupIdSchema.parse(crypto.randomUUID());
			instance.context.db
				.update(schema.caches)
				.set({
					managementKind: 'managed',
					managedPolicyId: policyId,
					managedPolicyRevision: managedPolicyRevisionSchema.parse(1),
					managedGroupId: groupId,
					leaseExpiresAt: isoTimestamp(new Date('2099-01-01T00:00:00.000Z')),
					selectionState: 'source-active'
				})
				.where(eq(schema.caches.name, cache.name))
				.run();
		});

		const narInfo = await readFetch(lookupPath(path.storePathHash));
		const availability = await readFetch('/reuse/reuse/api/v1/missing-paths', {
			body: JSON.stringify({ storePathHashes: [path.storePathHash] }),
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
			narInfoStatus: StatusCodes.NOT_FOUND,
			availabilityStatus: StatusCodes.OK,
			body: { missingStorePathHashes: [path.storePathHash] }
		});
	});

	const accessCases: {
		readonly label: string;
		readonly cache: CacheScope;
		readonly access: CacheAccessMode;
		readonly storePathHash: string;
		readonly prefix?: string;
		readonly isServed: boolean;
	}[] = [
		{
			label: 'an all selector does not select a private cache',
			cache: namedCache('builds'),
			access: 'private',
			storePathHash: '6'.repeat(32),
			isServed: false
		},
		{
			label: 'a matching prefix does not select a private cache',
			cache: namedCache('packages'),
			access: 'private',
			storePathHash: '7'.repeat(32),
			prefix: 'p',
			isServed: false
		},
		{
			label: 'an all selector selects a tenant-access cache',
			cache: namedCache('private'),
			access: 'public',
			storePathHash: '8'.repeat(32),
			isServed: true
		},
		{
			label: 'a matching prefix selects a tenant-access cache',
			cache: namedCache('pr-9'),
			access: 'public',
			storePathHash: '9'.repeat(32),
			prefix: 'p',
			isServed: true
		}
	];

	it.each(accessCases)(
		'$label',
		async ({ cache, access, storePathHash, prefix, isServed }) => {
			const committed = await committedPath(
				'reuse-private-source',
				namedCache('source'),
				{
					storePathHash: '5'.repeat(32)
				}
			);
			await insertBackedRow(
				cache,
				storePathHash,
				committed.storePathHash,
				access
			);
			await setView(
				prefix === undefined ? [{ kind: 'all' }] : [{ kind: 'prefix', prefix }]
			);

			const narInfo = await readFetch(lookupPath(storePathHash));
			const availability = await readFetch(
				'/reuse/reuse/api/v1/missing-paths',
				{
					body: JSON.stringify({ storePathHashes: [storePathHash] }),
					headers: { 'content-type': 'application/json' },
					method: 'POST'
				}
			);
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
		}
	);

	it('answers a miss no-store when no selected cache holds the hash', async () => {
		const path = await committedPath('reuse-unselected', namedCache('other'), {
			storePathHash: '2'.repeat(32)
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);

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
		const path = await committedPath('reuse-no-view', namedCache('pr-1'), {
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

	it('misses instead of truncating past the candidate limit', async () => {
		const path = await committedPath('reuse-limit', namedCache('pr-0'), {
			storePathHash: '4'.repeat(32)
		});
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);

		for (let index = 1; index <= reuseCandidateLimit; index += 1) {
			await insertUnbackedRow(
				namedCache(`pr-${String(index)}`),
				path.storePathHash,
				path.narHash
			);
		}

		const response = await readFetch(lookupPath(path.storePathHash));
		const availability = await readFetch('/reuse/reuse/api/v1/missing-paths', {
			body: JSON.stringify({
				storePathHashes: [path.storePathHash]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		const body = cacheAvailabilityResponseSchema.parse(
			await availability.json()
		);

		expect({
			narInfoStatus: response.status,
			availabilityStatus: availability.status,
			body
		}).toStrictEqual({
			narInfoStatus: StatusCodes.NOT_FOUND,
			availabilityStatus: StatusCodes.OK,
			body: { missingStorePathHashes: [path.storePathHash] }
		});
	});

	it('serves at exactly the candidate limit', async () => {
		const path = await committedPath('reuse-limit-edge', namedCache('pr-0'), {
			storePathHash: 'f4'.repeat(16)
		});
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);

		for (let index = 1; index < reuseCandidateLimit; index += 1) {
			await insertUnbackedRow(
				namedCache(`pr-${String(index)}`),
				path.storePathHash,
				path.narHash
			);
		}

		const response = await readFetch(lookupPath(path.storePathHash));
		const narInfo = NarInfo.parse(await response.text());

		expect({
			status: response.status,
			narHash: narInfo.narHash.toString()
		}).toStrictEqual({
			status: StatusCodes.OK,
			narHash: path.narHash
		});
	});

	it('answers conflicting candidates as a miss', async () => {
		const first = await committedPath('reuse-conflict-a', namedCache('pr-1'), {
			storePathHash: 'c'.repeat(32),
			name: 'first'
		});
		await committedPath('reuse-conflict-b', namedCache('pr-2'), {
			storePathHash: 'c'.repeat(32),
			name: 'first'
		});
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);

		const response = await readFetch(lookupPath(first.storePathHash));

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('merges the signature sets of identical candidates deterministically', async () => {
		const extraSignature = `other-1:${btoa('another signature')}`;
		const path = await committedPath('reuse-merge', namedCache('pr-1'), {
			storePathHash: '5'.repeat(32)
		});
		await committedPath('reuse-merge', namedCache('pr-2'), {
			storePathHash: '5'.repeat(32)
		});
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);

		const baselineResponse = await readFetch(lookupPath(path.storePathHash));
		const baseline = NarInfo.parse(await baselineResponse.text());
		const storePathHash = storePathHashSchema.parse(path.storePathHash);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = resolvedCache(instance.context, namedCache('pr-2'));
			const target = and(
				eq(schema.narInfos.cacheId, cache.id),
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
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);
		const storePathHash = 'd'.repeat(32);
		await insertUnbackedRow(
			namedCache('pr-1'),
			storePathHash,
			`sha256:${'g'.repeat(52)}`
		);

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
		const path = await committedPath(seed, namedCache('pr-1'), {
			storePathHash
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
		await remove(path.narHash);

		const response = await readFetch(lookupPath(path.storePathHash));

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('gates a private view lookup behind the tenant read credential', async () => {
		const path = await committedPath('reuse-private', namedCache('pr-1'), {
			storePathHash: '9'.repeat(32),
			access: 'private'
		});
		await setView([{ kind: 'named', name: 'pr-1' }], 'reuse', 'private');
		await provisionFixtureTenant({
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
