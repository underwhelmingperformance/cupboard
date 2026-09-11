import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import type { CheckReport } from '@cupboard/protocol/reports';
import { checkReportSchema } from '@cupboard/protocol/reports';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	activateObjectIncarnation,
	reserveObjectIncarnation
} from '../blob/object-incarnation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	cacheWriteGrants,
	corruptCommittedNarInfo,
	currentNarObjectKey,
	currentServer,
	initialise,
	issueServerSignedToken,
	narBytes,
	narHash,
	pushPath,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	verifiablePath
} from '../test-support.ts';

import {
	type CheckCursor,
	IntegrityCheckService
} from './integrity-check-service.ts';
import { withSubrequestSlice } from './subrequest-slice.ts';

const startOfScan: CheckCursor = { cache: '', storePathHash: '' };

async function runCheck(
	token: string,
	isDeep = false,
	cursor: CheckCursor = startOfScan
): Promise<CheckReport> {
	const query = new URLSearchParams();

	if (isDeep) {
		query.set('deep', 'true');
	}

	if (cursor.cache !== '' || cursor.storePathHash !== '') {
		query.set('cursorCache', cursor.cache);
		query.set('cursor', cursor.storePathHash);
	}

	const search = query.toString();
	const response = await authorisedFetch(
		search === '' ? '/check' : `/check?${search}`,
		token
	);

	expect(response.status).toBe(StatusCodes.OK);

	return checkReportSchema.parse(await response.json());
}

describe('storage check', () => {
	beforeEach(resetTestServer);

	it.each([{ deep: false }, { deep: true }])(
		'reports no discrepancies for a healthy cache (deep: $deep)',
		async ({ deep }) => {
			const token = await initialise();
			const { metadata: alpha, nar: alphaNar } = await verifiablePath('alpha', {
				storePathHash: 'a'.repeat(32),
				name: 'alpha'
			});
			const { metadata: beta, nar: betaNar } = await verifiablePath('beta', {
				storePathHash: 'b'.repeat(32),
				name: 'beta'
			});

			await pushPath(token, alpha, DEFAULT_CACHE, alphaNar);
			await pushPath(token, beta, DEFAULT_CACHE, betaNar);

			expect(await runCheck(token, deep)).toStrictEqual({
				narInfosChecked: 2,
				narBlobsChecked: 2,
				cursor: '',
				cursorCache: '',
				discrepancies: []
			});
		}
	);

	it('resumes after the row a cursor names', async () => {
		const token = await initialise();
		const hashes = ['a', 'b', 'c'] as const;

		for (const letter of hashes) {
			const { metadata, nar } = await verifiablePath(`resume-${letter}`, {
				storePathHash: letter.repeat(32),
				name: `resume-${letter}`
			});
			await pushPath(token, metadata, DEFAULT_CACHE, nar);
		}

		const fromStart = await runCheck(token);
		const afterFirst = await runCheck(token, false, {
			cache: DEFAULT_CACHE,
			storePathHash: 'a'.repeat(32)
		});

		expect({ fromStart, afterFirst }).toStrictEqual({
			fromStart: {
				narInfosChecked: 3,
				narBlobsChecked: 3,
				cursor: '',
				cursorCache: '',
				discrepancies: []
			},
			afterFirst: {
				narInfosChecked: 2,
				narBlobsChecked: 2,
				cursor: '',
				cursorCache: '',
				discrepancies: []
			}
		});
	});

	// The page bounds the rows a pass reads; the slice bounds the R2 calls it
	// makes. A pass that runs out of slice stops at a row it has not started and
	// reports that row, so the next pass repeats nothing and skips nothing.
	it('stops on its subrequest slice and resumes at the row it did not start', async () => {
		const token = await initialise();

		for (const letter of ['a', 'b', 'c'] as const) {
			const { metadata, nar } = await verifiablePath(`slice-${letter}`, {
				storePathHash: letter.repeat(32),
				name: `slice-${letter}`
			});
			await pushPath(token, metadata, DEFAULT_CACHE, nar);
		}

		// Three subrequests buy the pass's one D1 read of the page's blob facts and
		// then one shallow row: its narinfo head and its NAR head. Reading the page
		// itself costs none, being the object's own SQLite.
		const report = await runInDurableObject(currentServer(), (instance) =>
			withSubrequestSlice(
				() =>
					new IntegrityCheckService(instance.context).check(false, startOfScan),
				3
			)
		);

		expect({
			narInfosChecked: report.narInfosChecked,
			cursorCache: report.cursorCache,
			cursor: report.cursor,
			discrepancies: report.discrepancies
		}).toStrictEqual({
			narInfosChecked: 1,
			cursorCache: DEFAULT_CACHE,
			cursor: 'b'.repeat(32),
			discrepancies: []
		});
	});

	it('reports a missing narinfo R2 object', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		expect(await runCheck(token)).toStrictEqual({
			narInfosChecked: 1,
			narBlobsChecked: 1,
			cursor: '',
			cursorCache: '',
			discrepancies: [
				{
					kind: 'missing-narinfo-object',
					cache: '',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
	});

	it('reports a missing NAR for every narinfo that references it', async () => {
		const token = await initialise();
		const alpha = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'alpha'
		});
		const beta = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'beta'
		});

		await pushPath(token, alpha);
		await pushPath(token, beta);
		await env.BLOBS.delete(await currentNarObjectKey(narHash));

		expect(await runCheck(token)).toStrictEqual({
			narInfosChecked: 2,
			narBlobsChecked: 1,
			cursor: '',
			cursorCache: '',
			discrepancies: [
				{
					kind: 'missing-nar',
					cache: '',
					storePathHash: alpha.storePathHash,
					narHash
				},
				{
					kind: 'missing-nar',
					cache: '',
					storePathHash: beta.storePathHash,
					narHash
				}
			]
		});
	});

	it('reports tampered compressed bytes only during a deep check', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);

		const tampered = new Uint8Array([9, 9, 9, 9]);
		await env.BLOBS.put(await currentNarObjectKey(metadata.narHash), tampered, {
			sha256: await crypto.subtle.digest('SHA-256', tampered)
		});

		expect({
			shallow: await runCheck(token),
			deep: await runCheck(token, true)
		}).toStrictEqual({
			shallow: {
				narInfosChecked: 1,
				narBlobsChecked: 1,
				cursor: '',
				cursorCache: '',
				discrepancies: []
			},
			deep: {
				narInfosChecked: 1,
				narBlobsChecked: 1,
				cursor: '',
				cursorCache: '',
				discrepancies: [
					{
						kind: 'file-hash-mismatch',
						cache: '',
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash
					}
				]
			}
		});
	});

	it('catches a stored NAR that decompresses to a different hash on a deep check', async () => {
		const token = await initialise();
		const claimed = await verifiableNar('claimed-but-not-stored');
		const { metadata, nar } = await verifiablePath('stored', {
			storePathHash: 'c'.repeat(32),
			name: 'stored'
		});

		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		// Store `nar` under the hash for `claimed`, then make the compressed-file
		// metadata consistent with that substitution. Only decompression exposes
		// the incorrect NAR hash.
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const incarnation = await reserveObjectIncarnation(
			database,
			'nar',
			claimed.narHash
		);
		await env.BLOBS.put(
			narObjectKey(claimed.narHash, incarnation.incarnation),
			nar.narBytes,
			{
				sha256: await crypto.subtle.digest('SHA-256', nar.narBytes)
			}
		);
		await activateObjectIncarnation(
			database,
			'nar',
			claimed.narHash,
			incarnation.incarnation
		);
		await database
			.insert(d1Schema.blobState)
			.values({
				narHash: claimed.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				compression: 'zstd',
				narSize: nar.narSize,
				incarnation: incarnation.incarnation,
				verifiedAt: isoTimestamp(new Date())
			})
			.onConflictDoUpdate({
				target: d1Schema.blobState.narHash,
				set: {
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength,
					narSize: nar.narSize,
					incarnation: incarnation.incarnation,
					verifiedAt: isoTimestamp(new Date())
				}
			})
			.run();
		await corruptCommittedNarInfo(metadata.storePathHash, {
			narHash: claimed.narHash
		});

		const report = await runCheck(token, true);

		expect(report.discrepancies).toStrictEqual([
			{
				kind: 'nar-hash-mismatch',
				cache: '',
				storePathHash: metadata.storePathHash,
				narHash: claimed.narHash
			}
		]);
	});

	it('catches a stored NAR that decompresses to a different size on a deep check', async () => {
		const token = await initialise();
		const { metadata, nar } = await verifiablePath('sized', {
			storePathHash: 'd'.repeat(32),
			name: 'sized'
		});

		await pushPath(token, metadata, DEFAULT_CACHE, nar);
		await corruptCommittedNarInfo(metadata.storePathHash, {
			narSize: nar.narSize + 4096
		});

		const report = await runCheck(token, true);

		expect(report.discrepancies).toStrictEqual([
			{
				kind: 'nar-size-mismatch',
				cache: '',
				storePathHash: metadata.storePathHash,
				narHash: nar.narHash
			}
		]);
	});

	it('requires admin scope', async () => {
		await initialise();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const response = await authorisedFetch('/check', writeToken);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});
});
