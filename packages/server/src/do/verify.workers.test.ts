import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import type { VerifyReport } from '@cupboard/protocol/reports';
import { verifyReportSchema } from '@cupboard/protocol/reports';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfos } from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	blobStateCount,
	cacheWriteGrants,
	corruptCommittedNarInfo,
	currentNarObjectKey,
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

import { maxOutgoingConnections } from './bulk.ts';

const buildsCache = cacheNameSchema.parse('builds');

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

	it('restores a missing narinfo object', async () => {
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

		// Upload validation rejects this control character. Writing it directly
		// reproduces a legacy row whose narinfo cannot be rendered.
		await corruptCommittedNarInfo(poison.storePathHash, { deriver: 'a\nb' });

		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, sound.storePathHash)
		);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, poison.storePathHash)
		);

		const report = await runVerify(token);

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

	it('restores a missing narinfo object in a named cache', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata, 'builds');
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, buildsCache)
		);

		const report = await runVerify(token);
		const restored = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, buildsCache)
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

	it('removes a narinfo after its NAR disappears and leaves its blob state for the reaper', async () => {
		await useTestServer('verify-reconcile');
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));

		const report = await runVerify(token);
		const narInfoObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

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

	it('removes dangling narinfos for one NAR across caches and retires both edges', async () => {
		await useTestServer('verify-cross-cache');
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await pushPath(token, metadata, 'builds');
		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));

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

	it('keeps a present named-cache object unchanged when its R2 key sorts before the scan cursor', async () => {
		await useTestServer('verify-crossorder');
		const token = await initialise();

		// R2 puts the named-cache object (`narinfo/aa/…`) before the default-cache
		// object (`narinfo/zzz…`), while the database scan visits them in the
		// opposite order.
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

		// One-row batches make the named-cache scan resume after the default `z`
		// cursor, whose R2 key sorts after the named-cache object.
		const first = await runVerify(token, 1);
		const second = await runVerify(token, 1);

		expect({
			first: first.narInfoObjectsRestored,
			second: second.narInfoObjectsRestored
		}).toStrictEqual({ first: 0, second: 0 });
	});

	it('avoids an R2 list when scan order and object-key order diverge', async () => {
		await useTestServer('verify-divergent');
		const token = await initialise();

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

		await runVerify(token, 1);

		// The next batch is the named cache, whose object sorts before the `z`
		// cursor. Resuming from the cursor would skip it and listing from the start
		// would rescan the prefix. The batch must use per-row heads instead.
		const list = vi.spyOn(env.BLOBS, 'list');

		try {
			await runVerify(token, 1);

			expect(list).not.toHaveBeenCalled();
		} finally {
			list.mockRestore();
		}
	});

	it('falls back to per-row heads when the narinfo object listing fails', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

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

	it('bounds orphan listing before falling back to heads', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'z'.repeat(32)
		});

		await pushPath(token, metadata);

		const prefix = `t/${fixtureTenant}/narinfo/`;
		for (let index = 0; index < maxOutgoingConnections + 2; index += 1) {
			await env.BLOBS.put(
				`${prefix}${String(index).padStart(32, '0')}`,
				'orphan'
			);
		}

		const originalList = env.BLOBS.list.bind(env.BLOBS);
		const list = vi
			.spyOn(env.BLOBS, 'list')
			.mockImplementation((options?: R2ListOptions) =>
				originalList({ ...options, limit: 1 })
			);
		const head = vi.spyOn(env.BLOBS, 'head');

		try {
			const report = await runVerify(token, 1);
			const targetKey = narInfoObjectKey(fixtureTenant, metadata.storePathHash);

			expect({
				listCalls: list.mock.calls.length,
				targetHeaded: head.mock.calls.some(([key]) => key === targetKey),
				cursor: report.cursor,
				wrapped: report.wrapped
			}).toStrictEqual({
				listCalls: maxOutgoingConnections,
				targetHeaded: true,
				cursor: metadata.storePathHash,
				wrapped: false
			});
		} finally {
			list.mockRestore();
			head.mockRestore();
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

		// The second path has a reserved narinfo row but no reference edge or
		// narinfo object. Reconciliation must ignore it so the path cannot be served
		// before its bytes are verified.
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
