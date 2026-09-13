import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narInfos, pendingUploads } from '../db/schema.ts';
import { narObjectKeyPrefix } from '../http/http.ts';
import {
	collectVerificationPasses,
	currentServer,
	deferFreshUpload,
	flakyD1,
	initialise,
	resetTestServer,
	syntheticStorePathHash,
	useTestServer,
	withDeployedSubrequestAllowance
} from '../test-support.ts';

import { boundedD1 } from './bounded-io.ts';
import { maintenancePassCursorKey } from './server.ts';
import { UploadStateService } from './upload-state-service.ts';
import {
	type PendingVerificationBatch,
	type VerificationResult
} from './verification-service.ts';

type DeferredUpload = Awaited<ReturnType<typeof deferFreshUpload>>;

const pushConcurrency = 6;

/**
 * Stages `count` fresh uploads with bytes unique to this fixture. The distinct
 * seeds ensure each promotion must write a new canonical object.
 */
async function deferFreshUploads(
	server: string,
	count: number,
	seedPrefix: string,
	indexOffset: number
): Promise<readonly DeferredUpload[]> {
	await useTestServer(server);

	const token = await initialise();

	// Claiming and completing a row both enqueue another verification pass.
	// Capture those requests locally so the fixture's consumer need not drain
	// the queue before the gate reopens.
	await collectVerificationPasses();

	const deferred: DeferredUpload[] = [];

	for (let start = 0; start < count; start += pushConcurrency) {
		const group = await Promise.all(
			Array.from(
				{ length: Math.min(pushConcurrency, count - start) },
				(_, offset) =>
					deferFreshUpload(
						token,
						`${seedPrefix}-${String(start + offset)}`,
						syntheticStorePathHash(indexOffset + start + offset)
					)
			)
		);
		deferred.push(...group);
	}

	return deferred;
}

function verifiedResults(
	claims: PendingVerificationBatch['claims'],
	uploads: readonly DeferredUpload[]
): VerificationResult[] {
	const byUploadId = new Map(
		uploads.map((upload) => [upload.uploadId, upload] as const)
	);

	return claims.map((claim) => {
		const upload = byUploadId.get(claim.uploadId);

		if (upload === undefined) {
			throw new Error(
				'The claim refers to an upload the fixture did not stage.'
			);
		}

		return {
			uploadId: claim.uploadId,
			verdict: {
				kind: 'verified',
				verification: {
					ok: true,
					fileHash: upload.nar.fileHash,
					fileSize: upload.nar.narBytes.byteLength
				}
			}
		} satisfies VerificationResult;
	});
}

async function driveInterruptedVerdict(server: string): Promise<{
	readonly heldAfterRecord: number;
	readonly verdictAfterRecord: string | null | undefined;
	readonly edgesAfterRecord: number;
	readonly claimsWhileHeld: number;
	readonly claimsAfterRevoke: number;
	readonly heldAfterDrain: number;
	readonly pendingAfterDrain: number;
	readonly pathsAfterDrain: number;
	readonly edgesAfterDrain: number;
	readonly edgesAfterSecondAlarm: number;
}> {
	const [upload] = await deferFreshUploads(server, 1, 'interrupted', 200);

	if (upload === undefined) {
		throw new Error('The interrupted verdict fixture staged no upload.');
	}

	const originalPut = env.BLOBS.put.bind(env.BLOBS);
	const put = vi
		.spyOn(env.BLOBS, 'put')
		.mockImplementation((key, value, options) =>
			key.startsWith(narObjectKeyPrefix) &&
			key.includes(upload.metadata.narHash)
				? Promise.reject(new Error('simulated promote outage'))
				: originalPut(key, value, options)
		);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			1,
			Number.MAX_SAFE_INTEGER
		);
		const local = drizzle(state.storage, {
			schema: { narInfos, pendingUploads }
		});
		const heldVerdicts = (): number =>
			local
				.select({ id: pendingUploads.id })
				.from(pendingUploads)
				.where(isNotNull(pendingUploads.recordedVerdictJson))
				.all().length;
		const committedPaths = (): number =>
			local
				.select({ storePathHash: narInfos.storePathHash })
				.from(narInfos)
				.all().length;
		// Charging a commit writes its reference edge. Count those edges to detect
		// duplicate commits to the shared database.
		const edgeFilter = and(
			eq(d1Schema.blobReference.tenant, instance.context.requireTenant()),
			eq(d1Schema.blobReference.storePathHash, upload.metadata.storePathHash)
		);
		const edgeCount = async (): Promise<number> => {
			const edges = await instance.context.d1
				.select({ narHash: d1Schema.blobReference.narHash })
				.from(d1Schema.blobReference)
				.where(edgeFilter)
				.all();

			return edges.length;
		};

		try {
			await state.storage.deleteAlarm();
			await instance.recordVerifications(
				claim.owner,
				verifiedResults(claim.claims, [upload])
			);

			const heldAfterRecord = heldVerdicts();
			const verdictAfterRecord = local
				.select({ verdict: pendingUploads.verdict })
				.from(pendingUploads)
				.where(eq(pendingUploads.id, upload.uploadId))
				.get()?.verdict;
			const edgesAfterRecord = await edgeCount();
			const whileHeld = await instance.claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);

			// A client re-drive revokes the claim, which makes the recorded verdict
			// inapplicable. The row is then the consumer's again.
			new UploadStateService(instance.context).markUploadPending(
				upload.uploadId
			);
			const afterRevoke = await instance.claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);

			// Put the verdict back the way the interrupted invocation left it, so
			// the drain has something to apply once promotion works again.
			await instance.recordVerifications(
				afterRevoke.owner,
				verifiedResults(afterRevoke.claims, [upload])
			);

			// Promotion works again from here, so the next alarm's drain can settle
			// the row it left holding a verdict.
			put.mockRestore();
			await state.storage.deleteAlarm();
			await instance.alarm();

			const heldAfterDrain = heldVerdicts();
			const pendingAfterDrain = local
				.select({ id: pendingUploads.id })
				.from(pendingUploads)
				.all().length;
			const pathsAfterDrain = committedPaths();
			const edgesAfterDrain = await edgeCount();

			await state.storage.deleteAlarm();
			await instance.alarm();

			return {
				heldAfterRecord,
				verdictAfterRecord,
				edgesAfterRecord,
				claimsWhileHeld: whileHeld.claims.length,
				claimsAfterRevoke: afterRevoke.claims.length,
				heldAfterDrain,
				pendingAfterDrain,
				pathsAfterDrain,
				edgesAfterDrain,
				edgesAfterSecondAlarm: await edgeCount()
			};
		} finally {
			put.mockRestore();
		}
	});
}

describe('recorded verdict durability', () => {
	beforeEach(resetTestServer);

	it('retains an interrupted verdict and applies it once on a later pass', async () => {
		const driven = await driveInterruptedVerdict(
			'verify-allowance-interrupted'
		);

		expect(driven).toStrictEqual({
			heldAfterRecord: 1,
			verdictAfterRecord: 'pending',
			edgesAfterRecord: 0,
			claimsWhileHeld: 0,
			claimsAfterRevoke: 1,
			heldAfterDrain: 0,
			pendingAfterDrain: 0,
			pathsAfterDrain: 1,
			edgesAfterDrain: 1,
			edgesAfterSecondAlarm: 1
		});
	}, 240_000);
});

// A second consumer's verdict, written to the row while the first consumer's
// application is in flight. The owner differs from any owner a real claim
// issues, so the fence has something distinct to protect.
const replacementOwner = 'replacement-consumer';
const replacementVerdictJson = JSON.stringify({
	owner: replacementOwner,
	verdict: { kind: 'promoted' }
});

/**
 * Records one consumer's verdict and, while that verdict is being applied,
 * revokes its claim and puts a second consumer's verdict on the row. Reports
 * the row state after the first application finishes.
 *
 * The interleave runs when the application reads the shared blob row, which is
 * the first D1 read it makes. From that point the first consumer no longer owns
 * the row, so it stops and clears the verdict it read.
 */
async function driveVerdictAfterRevoke(server: string): Promise<{
	readonly didInterleave: boolean;
	readonly claimOwner: string | null | undefined;
	readonly recordedVerdictJson: string | null | undefined;
}> {
	const [upload] = await deferFreshUploads(server, 1, 'revoked', 300);

	if (upload === undefined) {
		throw new Error('The revoked verdict fixture staged no upload.');
	}

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			1,
			Number.MAX_SAFE_INTEGER
		);
		const local = drizzle(state.storage, { schema: { pendingUploads } });
		let didInterleave = false;
		const interleave = (): void => {
			if (didInterleave) {
				return;
			}

			didInterleave = true;
			local
				.update(pendingUploads)
				.set({
					claimOwner: replacementOwner,
					claimedAt: isoTimestamp(new Date()),
					recordedVerdictJson: replacementVerdictJson
				})
				.where(eq(pendingUploads.id, upload.uploadId))
				.run();
		};
		const real = instance.context.d1;
		const interleaving = flakyD1(env.CUPBOARD_DB, {
			failures: 0,
			matches: (query) => query.includes('blob_state'),
			onMatch: interleave
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(interleaving), { schema: d1Schema })
		});

		try {
			await state.storage.deleteAlarm();
			await instance.recordVerifications(
				claim.owner,
				verifiedResults(claim.claims, [upload])
			);
		} finally {
			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: real
			});
		}

		const row = local
			.select()
			.from(pendingUploads)
			.where(eq(pendingUploads.id, upload.uploadId))
			.get();

		return {
			didInterleave,
			claimOwner: row?.claimOwner,
			recordedVerdictJson: row?.recordedVerdictJson
		};
	});
}

describe('recorded verdict fencing', () => {
	beforeEach(resetTestServer);

	it('keeps a replacement verdict when the revoked owner resumes its clear', async () => {
		const driven = await driveVerdictAfterRevoke('verify-fence-revoke');

		// The first consumer read its own verdict. It must preserve the replacement
		// recorded after the second consumer took over the row. Clearing it would
		// leave the row leased without a recorded verdict until its lease expired,
		// and
		// the NAR would have to be decoded again.
		expect(driven).toStrictEqual({
			didInterleave: true,
			claimOwner: replacementOwner,
			recordedVerdictJson: replacementVerdictJson
		});
	}, 240_000);
});

// Malformed JSON that an interrupted write could leave in a verdict row.
const malformedVerdictJson = '{"owner"';

/**
 * Claims three deferred uploads and records a verdict for each. The recording
 * applies one and leaves two on their rows; the fixture then replaces the
 * lower-numbered held verdict with text that is not JSON and runs two alarms.
 *
 * A drain pass applies one verdict, so the first alarm reaches the malformed
 * one and the second reaches the verdict behind it.
 */
async function driveMalformedVerdict(server: string): Promise<{
	readonly heldAfterRecord: number;
	readonly heldAfterFirstAlarm: number;
	readonly heldAfterSecondAlarm: number;
	readonly isMalformedVerdictCleared: boolean;
	readonly pendingAfterDrain: number;
	readonly publishedPaths: number;
}> {
	const uploads = await deferFreshUploads(server, 3, 'malformed', 500);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			uploads.length,
			Number.MAX_SAFE_INTEGER
		);
		const local = drizzle(state.storage, {
			schema: { narInfos, pendingUploads }
		});
		const heldRows = (): (typeof pendingUploads.$inferSelect)[] =>
			local
				.select()
				.from(pendingUploads)
				.where(isNotNull(pendingUploads.recordedVerdictJson))
				.orderBy(asc(pendingUploads.id))
				.all();

		await state.storage.deleteAlarm();
		await withDeployedSubrequestAllowance(instance.context, 125, () =>
			instance.recordVerifications(
				claim.owner,
				verifiedResults(claim.claims, uploads)
			)
		);

		const held = heldRows();
		const malformed = held[0];

		if (malformed === undefined) {
			throw new Error('The malformed verdict fixture held no verdict.');
		}

		local
			.update(pendingUploads)
			.set({ recordedVerdictJson: malformedVerdictJson })
			.where(eq(pendingUploads.id, malformed.id))
			.run();

		// Start the rotation at the first pass, so each alarm reaches the verdict
		// drain rather than resuming after it.
		await state.storage.delete(maintenancePassCursorKey);
		await state.storage.deleteAlarm();
		await instance.alarm();

		const heldAfterFirstAlarm = heldRows().length;

		await state.storage.delete(maintenancePassCursorKey);
		await state.storage.deleteAlarm();
		await instance.alarm();

		return {
			heldAfterRecord: held.length,
			heldAfterFirstAlarm,
			heldAfterSecondAlarm: heldRows().length,
			isMalformedVerdictCleared:
				local
					.select({ recordedVerdictJson: pendingUploads.recordedVerdictJson })
					.from(pendingUploads)
					.where(eq(pendingUploads.id, malformed.id))
					.get()?.recordedVerdictJson == undefined,
			pendingAfterDrain: local
				.select({ id: pendingUploads.id })
				.from(pendingUploads)
				.all().length,
			publishedPaths: local
				.select({ storePathHash: narInfos.storePathHash })
				.from(narInfos)
				.all().length
		};
	});
}

describe('unreadable recorded verdicts', () => {
	beforeEach(resetTestServer);

	it('clears a verdict it cannot read and applies the one behind it', async () => {
		const driven = await driveMalformedVerdict('verify-fence-malformed');

		// The drain cannot apply malformed JSON. It clears the value and returns the
		// row to ordinary claiming, so the malformed value cannot stop the
		// verdict behind it from being applied on the next pass.
		expect(driven).toStrictEqual({
			heldAfterRecord: 2,
			heldAfterFirstAlarm: 0,
			heldAfterSecondAlarm: 0,
			isMalformedVerdictCleared: true,
			pendingAfterDrain: 1,
			publishedPaths: 2
		});
	}, 240_000);
});
