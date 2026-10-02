import { rootLogger } from '@cupboard/logger';
import type {
	NixSha256HashString,
	StorePathHash
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import {
	armBlobReaperTimer,
	blobReferenceRows,
	blobStateArmTimes,
	blobStateNarHashes,
	commitPath,
	currentServer,
	currentServerTenant,
	deferFreshUpload,
	expectSingleCommitDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	resetTestServer,
	testBase,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

const byNarHash = (a: string, b: string) => a.localeCompare(b);

interface StatementDetail {
	readonly sql: string;
	readonly parameters: readonly unknown[];
}

// Workerd's prepared statements carry the SQL they will run and the values they
// bind. The Workers types do not describe either, so read them through a guard
// rather than trusting the shape.
function statementDetail(statement: D1PreparedStatement): StatementDetail {
	const candidate: unknown = statement;

	if (
		typeof candidate === 'object' &&
		candidate !== null &&
		'statement' in candidate &&
		typeof candidate.statement === 'string' &&
		'params' in candidate &&
		Array.isArray(candidate.params)
	) {
		return { sql: candidate.statement, parameters: candidate.params };
	}

	throw new Error('A D1 prepared statement did not expose its SQL and values.');
}

interface BatchFaultPlan {
	/**
	 * The NAR hashes selected for fault injection.
	 */
	readonly narHashes: ReadonlySet<string>;
	/**
	 * Whether the batch contains the SQL operation this plan rejects.
	 */
	readonly matches: (sql: string) => boolean;
	/**
	 * How many matching batches to reject. The rest run normally.
	 */
	readonly limit?: number;
}

interface BatchFault {
	readonly rejected: () => number;
	readonly restore: () => void;
}

/**
 * Rejects the D1 batches a plan selects, and reports how many it rejected.
 *
 * The isolate shares one binding across its tests, so call order is not stable.
 * This helper rejects a batch only when it binds one of the selected NAR hashes
 * and contains the selected SQL operation.
 *
 * Each test asserts the rejection count, so a query change that prevents fault
 * injection also fails the test.
 */
function failBatchesFor(plan: BatchFaultPlan): BatchFault {
	const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
	const limit = plan.limit ?? Infinity;
	let rejected = 0;

	// A statement binds a hash on its own or inside the JSON list that carries a
	// whole set of them, so look for the hash within the bound value.
	const hasSelectedHash = (value: unknown): boolean =>
		typeof value === 'string' &&
		[...plan.narHashes].some((narHash) => value.includes(narHash));

	const spy = vi
		.spyOn(env.CUPBOARD_DB, 'batch')
		.mockImplementation((statements) => {
			const details = statements.map((statement) => statementDetail(statement));
			const isThisTest = details.some((detail) =>
				detail.parameters.some((value) => hasSelectedHash(value))
			);
			const sql = details.map((detail) => detail.sql).join(' ');

			if (isThisTest && rejected < limit && plan.matches(sql)) {
				rejected += 1;

				return Promise.reject(new Error('simulated D1 fault'));
			}

			return originalBatch(statements);
		});

	return {
		rejected: () => rejected,
		restore: () => {
			spy.mockRestore();
		}
	};
}

// Returns the D1 reference edges written while charging one NAR hash, reduced to
// the fields that identify the published path.
async function referenceEdgesFor(narHash: NixSha256HashString): Promise<
	{
		storePathHash: StorePathHash;
		generation: number;
		narHash: NixSha256HashString;
	}[]
> {
	const rows = await blobReferenceRows();

	return rows
		.filter((row) => row.narHash === narHash)
		.map((row) => ({
			storePathHash: row.storePathHash,
			generation: row.generation,
			narHash: row.narHash
		}));
}

// The batch that reserves the promotion's incarnation. The tests allow this
// batch and inject a fault into a later batch.
const promotionReservation = '"object_incarnation"';

// The batch that prefetches the tenant's presence rows for a page of hashes.
const presencePrefetch = '"tenant_blob"';

async function deferReuseUpload(
	token: string,
	firstSeed: string,
	firstStorePathHash: string,
	secondStorePathHash: string
): Promise<{ uploadId: UploadId; narHash: string }> {
	const nar = await verifiableNar(firstSeed);
	const first = uploadMetadata({
		name: firstSeed,
		storePathHash: firstStorePathHash,
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});

	await commitPath(token, first, nar);

	const second = uploadMetadata({
		name: 'second',
		storePathHash: secondStorePathHash,
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});
	const reuse = expectSingleCommitDecision(
		await negotiateUploads(token, [second]),
		second
	);

	await markUploadPendingVerification(reuse.uploadId);

	return { uploadId: reuse.uploadId, narHash: nar.narHash };
}

describe('promotion after a transient D1 batch failure', () => {
	beforeEach(resetTestServer);

	it('settles a fresh and a reuse claim after one batch rejection', async () => {
		const token = await initialise();

		const fresh = await deferFreshUpload(
			token,
			'batch-retry-fresh',
			'a'.repeat(32)
		);
		const reuse = await deferReuseUpload(
			token,
			'batch-retry-reuse',
			'b'.repeat(32),
			'c'.repeat(32)
		);

		// Both claims share the presence prefetch, so rejecting it once makes both
		// of them settle through the retry.
		const fault = failBatchesFor({
			narHashes: new Set([fresh.metadata.narHash, reuse.narHash]),
			matches: (sql) => sql.includes(presencePrefetch),
			limit: 1
		});

		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			fault.restore();
		}

		const blobState = await blobStateNarHashes();

		expect({
			rejectedBatches: fault.rejected(),
			freshVerdict: await pendingUploadVerdict(fresh.uploadId),
			reuseVerdict: await pendingUploadVerdict(reuse.uploadId),
			blobStateHashes: blobState.map((row) => row.narHash).toSorted(byNarHash)
		}).toStrictEqual({
			rejectedBatches: 1,
			freshVerdict: undefined,
			reuseVerdict: undefined,
			blobStateHashes: [fresh.metadata.narHash, reuse.narHash].toSorted(
				byNarHash
			)
		});
	});
});

// A persistent D1 read fault can occur after R2 promotion has completed. The
// claim must remain pending and keep the verdict the pass recorded, so the NAR
// is never decoded again. A row holding both a recorded verdict and its claim
// owner is not claimable, so the verdict-drain maintenance pass is what
// finishes the upload from the durable `blob_state` row.
describe('promotion followed by a persistent D1 fault', () => {
	beforeEach(resetTestServer);

	it('retains the recorded verdict until the drain deadline after all batch attempts reject', async () => {
		await withoutAlarmArming(async () => {
			const token = await initialise();
			const fresh = await deferFreshUpload(
				token,
				'batch-fallback-fresh',
				'1'.repeat(32)
			);
			const now = Date.now();
			const pendingState = () =>
				runInDurableObject(currentServer(), (instance) =>
					instance.context.db
						.select({
							verdict: pendingUploads.verdict,
							failures: pendingUploads.settleFailures,
							retryAfter: pendingUploads.settleRetryAfter,
							startedAt: pendingUploads.retryStartedActiveMs,
							category: pendingUploads.lastSettleError,
							owner: pendingUploads.claimOwner,
							recorded: pendingUploads.recordedVerdictJson
						})
						.from(pendingUploads)
						.where(eq(pendingUploads.id, fresh.uploadId))
						.get()
				);
			const fault = failBatchesFor({
				narHashes: new Set([fresh.metadata.narHash]),
				matches: (sql) => !sql.includes(promotionReservation)
			});
			try {
				await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
			} finally {
				fault.restore();
			}
			const pendingAfterFault = await pendingState();
			if (
				pendingAfterFault?.owner == undefined ||
				pendingAfterFault.retryAfter == undefined
			) {
				throw new Error(
					'The interrupted promotion did not retain its owner and retry deadline.'
				);
			}
			const afterFault = {
				pending: pendingAfterFault,
				blobState: await blobStateNarHashes(),
				edges: await referenceEdgesFor(fresh.metadata.narHash)
			};
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
			const afterConsumer = {
				pending: await pendingState(),
				edges: await referenceEdgesFor(fresh.metadata.narHash)
			};
			await runInDurableObject(currentServer(), (instance) => instance.alarm());
			const beforeDeadline = {
				pending: await pendingState(),
				edges: await referenceEdgesFor(fresh.metadata.narHash)
			};
			vi.setSystemTime(new Date(pendingAfterFault.retryAfter));
			await runInDurableObject(currentServer(), (instance) => instance.alarm());
			const afterDeadline = {
				pending: await pendingState(),
				edges: await referenceEdgesFor(fresh.metadata.narHash)
			};
			const waiting = {
				verdict: 'pending',
				failures: 1,
				retryAfter: new Date(now + 30_000).toISOString(),
				startedAt: 0,
				category: 'materialisation-failed',
				owner: pendingAfterFault.owner,
				recorded: JSON.stringify({
					owner: pendingAfterFault.owner,
					verdict: {
						kind: 'verified',
						verification: {
							ok: true,
							fileHash: fresh.metadata.fileHash,
							fileSize: fresh.metadata.fileSize
						}
					}
				})
			};
			expect({
				rejectedBatches: fault.rejected(),
				afterFault,
				afterConsumer,
				beforeDeadline,
				afterDeadline
			}).toStrictEqual({
				rejectedBatches: 3,
				afterFault: {
					pending: waiting,
					blobState: [{ narHash: fresh.metadata.narHash }],
					edges: []
				},
				afterConsumer: { pending: waiting, edges: [] },
				beforeDeadline: { pending: waiting, edges: [] },
				afterDeadline: {
					pending: undefined,
					edges: [
						{
							storePathHash: fresh.metadata.storePathHash,
							generation: 0,
							narHash: fresh.metadata.narHash
						}
					]
				}
			});
		});
	});
});

// A verification claim must clear an armed reaper timer before decoding. The
// reaper must not delete the canonical object while verification is in flight.
describe('reaper pin for claimed hashes', () => {
	beforeEach(resetTestServer);

	it('clears delete_after on armed blob_state rows before any decode', async () => {
		const token = await initialise();
		const reuse = await deferReuseUpload(
			token,
			'pin-reuse',
			'4'.repeat(32),
			'5'.repeat(32)
		);

		const armedUntil = new Date(testBase.getTime() + 5000);
		await armBlobReaperTimer(
			reuse.narHash as Parameters<typeof armBlobReaperTimer>[0],
			isoTimestamp(armedUntil)
		);

		const beforePass = await blobStateArmTimes();

		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		const afterPass = await blobStateArmTimes();

		expect({
			beforePassArmed: beforePass.some(
				(row) => row.narHash === reuse.narHash && row.deleteAfter !== undefined
			),
			afterPassArmed: afterPass.some(
				(row) => row.narHash === reuse.narHash && row.deleteAfter !== undefined
			),
			reuseVerdict: await pendingUploadVerdict(reuse.uploadId)
		}).toStrictEqual({
			beforePassArmed: true,
			afterPassArmed: false,
			reuseVerdict: undefined
		});
	});
});
