import { rootLogger } from '@cupboard/logger';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyTenant } from '../routing/scheduled.ts';
import {
	armBlobReaperTimer,
	blobStateArmTimes,
	blobStateNarHashes,
	commitPath,
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
	verifiableNar
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
	 * The NAR hashes whose work this fault applies to.
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
 * The binding is shared by everything this isolate runs, so a fault chosen by
 * call index lands on whichever batch happens to be that many calls in. This
 * rejects a batch only when it binds one of the test's own NAR hashes and its
 * SQL matches, which makes the fault independent of what else is running.
 *
 * The rejection count is part of what each test asserts. A query that stops
 * matching then fails the test rather than quietly injecting no fault at all.
 */
function failBatchesFor(plan: BatchFaultPlan): BatchFault {
	const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
	const limit = plan.limit ?? Infinity;
	let rejected = 0;

	const spy = vi
		.spyOn(env.CUPBOARD_DB, 'batch')
		.mockImplementation((statements) => {
			const details = statements.map((statement) => statementDetail(statement));
			const isThisTest = details.some((detail) =>
				detail.parameters.some(
					(value) => typeof value === 'string' && plan.narHashes.has(value)
				)
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

// The batch that reserves the promotion's incarnation. It runs before the
// stored blob metadata is read, and a fault after it is what these tests place.
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
// claim must remain pending and lose its lease so the next pass can finish it
// from the durable `blob_state` row.
describe('promotion followed by a persistent D1 fault', () => {
	beforeEach(resetTestServer);

	it('leaves the claim immediately retryable when all batch attempts reject', async () => {
		const token = await initialise();

		const fresh = await deferFreshUpload(
			token,
			'batch-fallback-fresh',
			'1'.repeat(32)
		);

		// The promotion reserves its incarnation and then reads the stored blob
		// metadata. Let the reservation through and reject everything after it,
		// including the per-row reads attempted after the prefetch fails.
		const fault = failBatchesFor({
			narHashes: new Set([fresh.metadata.narHash]),
			matches: (sql) => !sql.includes(promotionReservation)
		});

		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			fault.restore();
		}

		expect({
			rejectedBatches: fault.rejected(),
			freshVerdict: await pendingUploadVerdict(fresh.uploadId),
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			// The prefetch of the stored blob metadata, the presence prefetch, and
			// the charge the settle would have run.
			rejectedBatches: 3,
			freshVerdict: 'pending',
			blobState: [{ narHash: fresh.metadata.narHash }]
		});

		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		expect(await pendingUploadVerdict(fresh.uploadId)).toBeUndefined();
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
