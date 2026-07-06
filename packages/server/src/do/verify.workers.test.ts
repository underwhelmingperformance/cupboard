import type { VerifyReport } from '@cupboard/protocol/reports';
import { verifyReportSchema } from '@cupboard/protocol/reports';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfos } from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	blobStateCount,
	cacheWriteGrants,
	corruptCommittedNarInfo,
	initialise,
	issueServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	seedReservedNarInfo,
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
	const response = await authorisedFetch('/verify', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(limit === undefined ? {} : { limit })
	});

	expect(response.status).toBe(StatusCodes.OK);

	return verifyReportSchema.parse(await response.json());
}

describe('background verification', () => {
	beforeEach(resetTestServer);

	it('re-materialises a missing narinfo object', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		const report = await runVerify(token);
		const restored = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
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

	it('skips a narinfo row that cannot render and still advances the pass', async () => {
		const token = await initialise();
		const fileSize = narBytes.byteLength;
		const sound = uploadMetadata({
			fileSize,
			storePathHash: '1'.repeat(32),
			name: 'sound'
		});
		const poison = uploadMetadata({
			fileSize,
			storePathHash: '2'.repeat(32),
			name: 'poison'
		});

		await pushPath(token, sound);
		await pushPath(token, poison);

		// Corrupt the poison row's deriver with a control character it could never
		// have been uploaded with: rendering its narinfo now throws, the residue a
		// pre-validation upload could once have left.
		await corruptCommittedNarInfo(poison.storePathHash, { deriver: 'a\nb' });

		// Both narinfo objects are gone, so the pass tries to restore each.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, sound.storePathHash)
		);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, poison.storePathHash)
		);

		const report = await runVerify(token);

		// The unrenderable row is skipped, but the pass still restores the sound
		// row and advances its cursor to the end.
		expect({
			report,
			soundRestored:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, sound.storePathHash)
				)) !== null,
			poisonRestored:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, poison.storePathHash)
				)) !== null
		}).toStrictEqual({
			report: {
				scanned: 2,
				narInfoObjectsRestored: 1,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			soundRestored: true,
			poisonRestored: false
		});
	});

	it('re-materialises a missing narinfo object in a named cache', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata, 'builds');
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, 'builds')
		);

		const report = await runVerify(token);
		const restored = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, 'builds')
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
		await useTestServer('verify-reconcile');
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		const report = await runVerify(token);
		const narInfoObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
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
		await useTestServer('verify-advance');
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
		await useTestServer('verify-cross-cache');
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
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const response = await authorisedFetch('/verify', writeToken, {
			method: 'POST'
		});

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});

	it('does not falsely restore a named-cache object the cursor sorts after', async () => {
		await useTestServer('verify-crossorder');
		const token = await initialise();

		// A default-cache hash that sorts after a named cache's name, so in R2 key
		// order the named-cache object (`narinfo/aa/…`) sorts before the default one
		// (`narinfo/zzz…`), the opposite of the (cache, storePathHash) scan order.
		await pushPath(
			token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: 'z'.repeat(32),
				name: 'z'
			})
		);
		await pushPath(
			token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: 'b'.repeat(32),
				name: 'b'
			}),
			'aa'
		);

		// One row per batch: the second batch (the named cache) resumes after the
		// default 'z' cursor, whose key sorts after the named-cache object.
		const first = await runVerify(token, 1);
		const second = await runVerify(token, 1);

		expect({
			first: first.narInfoObjectsRestored,
			second: second.narInfoObjectsRestored
		}).toStrictEqual({ first: 0, second: 0 });
	});

	it('falls back to per-row heads when the narinfo object listing fails', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		// The bulk narinfo-object listing fails, so the reconcile must fall back to a
		// per-row head and still restore the missing object, rather than aborting.
		const list = vi
			.spyOn(env.BLOBS, 'list')
			.mockRejectedValue(new Error('r2 list unavailable'));

		try {
			const report = await runVerify(token);
			const restored = await env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash)
			);

			expect({
				restored: restored !== null,
				narInfoObjectsRestored: report.narInfoObjectsRestored
			}).toStrictEqual({ restored: true, narInfoObjectsRestored: 1 });
		} finally {
			list.mockRestore();
		}
	});

	it('leaves a reserved, unverified row that shares a committed NAR untouched', async () => {
		await useTestServer('verify-reserved');
		const token = await initialise();
		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'first'
		});
		await pushPath(token, first);

		// A second path reserved at commit for the same NAR: its narinfo row exists
		// but has no reference edge and no object yet. The verify pass, not the
		// reconcile, owns it, so it must not be restored and served before its own
		// bytes verify.
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'f'.repeat(32),
			name: 'second'
		});
		await seedReservedNarInfo(second, 0);

		const report = await runVerify(token);
		const secondObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, second.storePathHash)
		);

		expect({
			narInfoObjectsRestored: report.narInfoObjectsRestored,
			secondServed: secondObject !== null
		}).toStrictEqual({ narInfoObjectsRestored: 0, secondServed: false });
	});

	afterEach(() => {
		vi.useRealTimers();
	});
});
