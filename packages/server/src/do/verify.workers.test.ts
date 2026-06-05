import type { VerifyReport } from '@cupboard/protocol/reports';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfos } from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import {
	authorisedFetch,
	blobStateCount,
	initialise,
	mintServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	testServerFor,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

const healthy = {
	scanned: 1,
	narInfoObjectsRestored: 0,
	danglingNarInfosRemoved: 0,
	cursor: '',
	cursorCache: '',
	wrapped: true
} satisfies VerifyReport;

async function runVerify(token: string, limit?: number): Promise<VerifyReport> {
	const query = limit === undefined ? '' : `?limit=${String(limit)}`;
	const response = await authorisedFetch(`/verify${query}`, token, {
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<VerifyReport>();
}

describe('background verification', () => {
	beforeEach(resetTestServer);

	it('re-materialises a missing narinfo object', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(narInfoObjectKey(metadata.storePathHash));

		const report = await runVerify(token);
		const restored = await env.BLOBS.head(
			narInfoObjectKey(metadata.storePathHash)
		);

		expect({ report, restored: restored !== null }).toStrictEqual({
			report: {
				scanned: 1,
				narInfoObjectsRestored: 1,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			restored: true
		});
	});

	it('re-materialises a missing narinfo object in a named cache', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata, 'builds');
		await env.BLOBS.delete(narInfoObjectKey(metadata.storePathHash, 'builds'));

		const report = await runVerify(token);
		const restored = await env.BLOBS.head(
			narInfoObjectKey(metadata.storePathHash, 'builds')
		);

		expect({ report, restored: restored !== null }).toStrictEqual({
			report: {
				scanned: 1,
				narInfoObjectsRestored: 1,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			restored: true
		});
	});

	it('reconciles a dangling narinfo whose NAR object is gone, leaving the blob for the reaper', async () => {
		useTestServer('verify-reconcile');
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		const report = await runVerify(token);
		const narInfoObject = await env.BLOBS.head(
			narInfoObjectKey(metadata.storePathHash)
		);

		// Verify removes the dangling narinfo and retires its edge; the now-
		// unreferenced shared fact is left for the reaper to collect, not deleted here.
		expect({
			report,
			narInfoObjectGone: narInfoObject === null,
			blobs: await blobStateCount()
		}).toStrictEqual({
			report: {
				scanned: 1,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 1,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			narInfoObjectGone: true,
			blobs: 1
		});
	});

	it('advances the composite cursor across caches and wraps at the end', async () => {
		useTestServer('verify-advance');
		const token = await initialise();

		for (const hash of ['a', 'b']) {
			await pushPath(
				token,
				uploadMetadata({
					fileSize: narBytes.byteLength,
					storePathHash: hash.repeat(32),
					name: hash
				})
			);
		}
		for (const hash of ['c', 'd']) {
			await pushPath(
				token,
				uploadMetadata({
					fileSize: narBytes.byteLength,
					storePathHash: hash.repeat(32),
					name: hash
				}),
				'builds'
			);
		}

		const first = await runVerify(token, 2);
		const second = await runVerify(token, 2);
		const third = await runVerify(token, 2);

		expect({ first, second, third }).toStrictEqual({
			first: {
				scanned: 2,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: 'b'.repeat(32),
				cursorCache: '',
				wrapped: false
			},
			second: {
				scanned: 2,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: 'd'.repeat(32),
				cursorCache: 'builds',
				wrapped: false
			},
			third: {
				scanned: 0,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true
			}
		});
	});

	it('is idempotent on a healthy cache', async () => {
		const token = await initialise();

		await pushPath(token, uploadMetadata({ fileSize: narBytes.byteLength }));

		const first = await runVerify(token);
		const second = await runVerify(token);

		expect({ first, second }).toStrictEqual({
			first: healthy,
			second: healthy
		});
	});

	it('reconciles dangling narinfos for one NAR across caches, retiring both edges', async () => {
		useTestServer('verify-cross-cache');
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await pushPath(token, metadata, 'builds');
		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		const report = await runVerify(token);
		const narInfoCount = await runInDurableObject(
			testServerFor('verify-cross-cache'),
			(_instance, storage) =>
				drizzle(storage.storage, { schema: { narInfos } })
					.select()
					.from(narInfos)
					.all().length
		);
		const state = {
			blobs: await blobStateCount(),
			narInfos: narInfoCount
		};

		expect({ report, state }).toStrictEqual({
			report: {
				scanned: 2,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 2,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			// Both narinfos are removed and their edges retired; the single shared fact
			// is left, now unreferenced, for the reaper to collect once.
			state: { blobs: 1, narInfos: 0 }
		});
	});

	it('requires admin scope', async () => {
		await initialise();
		const writeToken = await mintServerSignedToken('write');

		const response = await authorisedFetch('/verify', writeToken, {
			method: 'POST'
		});

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});

	afterEach(() => {
		vi.useRealTimers();
	});
});
