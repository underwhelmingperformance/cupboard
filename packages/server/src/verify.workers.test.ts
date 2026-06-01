import type { VerifyReport } from '@cupboard/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { narBlobs, narInfos, orphanBlobDeletions } from './db/schema.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	orphanBlobDeletionGraceMs
} from './http.ts';
import {
	authorisedFetch,
	deleteTestBase,
	initialise,
	mintServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	testServerFor,
	uploadMetadata,
	useTestServer
} from './test-support.ts';

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

	it('reconciles a dangling narinfo and schedules its NAR after the grace window', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(deleteTestBase);
		useTestServer('verify-reconcile');
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		const report = await runVerify(token);
		const orphans = await runInDurableObject(
			testServerFor('verify-reconcile'),
			(_instance, state) =>
				drizzle(state.storage, { schema: { orphanBlobDeletions } })
					.select()
					.from(orphanBlobDeletions)
					.all()
		);
		const narInfoObject = await env.BLOBS.head(
			narInfoObjectKey(metadata.storePathHash)
		);

		expect({
			report,
			orphans,
			narInfoObjectGone: narInfoObject === null
		}).toStrictEqual({
			report: {
				scanned: 1,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 1,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			orphans: [
				{
					r2Key: narObjectKey(metadata.narHash),
					notBefore: new Date(
						deleteTestBase.getTime() + orphanBlobDeletionGraceMs
					).toISOString(),
					createdAt: deleteTestBase.toISOString()
				}
			],
			narInfoObjectGone: true
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

	it('reconciles dangling narinfos across caches and schedules the shared NAR once', async () => {
		useTestServer('verify-cross-cache');
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await pushPath(token, metadata, 'builds');
		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		const report = await runVerify(token);
		const state = await runInDurableObject(
			testServerFor('verify-cross-cache'),
			(_instance, storage) => {
				const database = drizzle(storage.storage, {
					schema: { narBlobs, narInfos, orphanBlobDeletions }
				});

				return {
					orphans: database.select().from(orphanBlobDeletions).all().length,
					blobs: database.select().from(narBlobs).all().length,
					narInfos: database.select().from(narInfos).all().length
				};
			}
		);

		expect({ report, state }).toStrictEqual({
			report: {
				scanned: 2,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 2,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			// The global unreferenced-NAR gate holds the blob until the last
			// referencing narinfo is removed, so it is scheduled exactly once.
			state: { orphans: 1, blobs: 0, narInfos: 0 }
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
