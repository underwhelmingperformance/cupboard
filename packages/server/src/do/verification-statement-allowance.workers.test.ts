import { isoTimestamp } from '@cupboard/protocol/scalars';
import { type ParsedUploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narInfos, pendingUploads, verificationCursor } from '../db/schema.ts';
import {
	d1StatementsPerInvocation,
	narObjectKeyPrefix,
	verifyClaimBatchSize,
	verifyClaimMaxNarBytes
} from '../http/http.ts';
import {
	bootstrap,
	collectVerificationPasses,
	commitPath,
	countingD1,
	currentServer,
	deferFreshUpload,
	expectSingleCommitDecision,
	flakyD1,
	initialise,
	type MeasuredInvocation,
	measureInvocations,
	narBytes,
	negotiateUploads,
	pushPath,
	resetTestServer,
	syntheticStorePathHash,
	uploadMetadata,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { boundedD1 } from './bounded-io.ts';
import { maintenancePassCursorKey } from './server.ts';
import { UploadStateService } from './upload-state-service.ts';
import {
	type PendingVerificationBatch,
	statementsPerRecordedVerdict,
	type VerificationResult
} from './verification-service.ts';

type DeferredUpload = Awaited<ReturnType<typeof deferFreshUpload>>;

const storePathAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

// A Durable Object may hold six outgoing connections at once, so push in groups
// of that size.
const pushConcurrency = 6;

// More committed paths than one verification pass can probe within its
// statement allowance, so the scan only reaches the end across several cron
// invocations.
const committedPaths = 100;

// Each row needs one probe. After maintenance eligibility uses its statements,
// the pass also reserves one statement for the committed-reference query and
// one for a removal. This page size uses the remaining allowance. The D1 binding
// still enforces the 50-statement limit.
const scanPageSize = 38;

// More rows than one claim settles without decoding, so the claim's limit
// applies and later claims have to settle the rest.
const reuseRows = 8;

type VerificationPassObservation = MeasuredInvocation<{
	readonly cursor: string;
}>;

type ClaimObservation = MeasuredInvocation<{
	readonly pendingRowsBefore: number;
	readonly passRequests: number;
}>;

// Store path hashes that sort in index order, so the scan cursor identifies how
// far one pass reached.
function indexedMetadata(index: number): ParsedUploadPathMetadata {
	const suffix =
		storePathAlphabet.charAt(Math.floor(index / 32)) +
		storePathAlphabet.charAt(index % 32);

	return uploadMetadata({
		storePathHash: `${'0'.repeat(30)}${suffix}`,
		name: `path-${suffix}`,
		fileSize: narBytes.byteLength
	});
}

async function commitScannedPaths(server: string): Promise<void> {
	await useTestServer(server);

	const { token } = await bootstrap();

	for (let start = 0; start < committedPaths; start += pushConcurrency) {
		await Promise.all(
			Array.from({ length: pushConcurrency }, (_, offset) =>
				pushPath(token, indexedMetadata(start + offset), 'builds')
			)
		);
	}
}

/**
 * Runs `invocations` cron verification passes over a cache of `committedPaths`
 * committed paths, and reports the D1 statement count and the scan cursor of
 * each one.
 *
 * Each measurement covers one `runVerification` call, matching one call from
 * the cron handler and one D1 allowance. The input gate prevents other work
 * from changing the state during a measurement.
 */
async function driveCronVerification(
	server: string,
	invocations: number
): Promise<{
	readonly passes: readonly VerificationPassObservation[];
	readonly committedRows: number;
}> {
	await commitScannedPaths(server);

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		const local = drizzle(state.storage, {
			schema: { narInfos, verificationCursor }
		});
		const scanCursor = (): string =>
			local
				.select({ hash: verificationCursor.lastStorePathHash })
				.from(verificationCursor)
				.where(eq(verificationCursor.id, 'active'))
				.get()?.hash ?? '';

		const passes = await measureInvocations(state, counting, {
			attempts: invocations,
			run: async () => {
				await instance.runVerification();

				return { cursor: scanCursor() };
			}
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return {
			passes,
			committedRows: local
				.select({ storePathHash: narInfos.storePathHash })
				.from(narInfos)
				.all().length
		};
	});
}

/**
 * Commits one path, then negotiates `reuseRows` further paths that reuse its
 * NAR. Each negotiation leaves an uncommitted row, which the caller marks as
 * pending. A claim settles these rows from the committed NAR without decoding
 * it again.
 */
async function queueReuseRows(server: string): Promise<readonly unknown[]> {
	await useTestServer(server);

	const token = await initialise();
	const nar = await verifiableNar('claim-reuse');
	const committed = uploadMetadata({
		name: 'canonical',
		storePathHash: 'a'.repeat(32),
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});

	await commitPath(token, committed, nar);

	// A claim asks the queue for another verification pass while rows remain.
	// Record those requests instead of sending them to a real queue.
	const requests = await collectVerificationPasses();

	for (let index = 0; index < reuseRows; index += 1) {
		const metadata = uploadMetadata({
			name: `reuse-${String(index)}`,
			storePathHash: syntheticStorePathHash(index),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		expectSingleCommitDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
	}

	return requests;
}

/**
 * Defers every negotiated row and runs `invocations` complete claim RPCs,
 * reporting the D1 statement count, the pending row count and the number of
 * verification passes each one asked the queue for.
 *
 * A claim leases the rows it hands to the consumer, so the fixture releases
 * those leases between invocations. That is the state a consumer leaves behind
 * when it abandons its batch.
 */
async function driveClaims(
	server: string,
	invocations: number
): Promise<{
	readonly claims: readonly ClaimObservation[];
	readonly pendingRows: number;
}> {
	const passRequests = await queueReuseRows(server);

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		const local = drizzle(state.storage, { schema: { pendingUploads } });
		const pendingDepth = (): number =>
			local.select({ id: pendingUploads.id }).from(pendingUploads).all().length;
		const releaseLeases = (): void => {
			local
				.update(pendingUploads)
				.set({ claimedAt: sql`null`, claimOwner: sql`null` })
				.run();
		};
		const observed = await measureInvocations(state, counting, {
			attempts: invocations,
			prepare: () => {
				local.update(pendingUploads).set({ verdict: 'pending' }).run();
			},
			run: async () => {
				releaseLeases();

				const requestsBefore = passRequests.length;
				const pendingRowsBefore = pendingDepth();
				await instance.claimVerificationBatch(
					verifyClaimBatchSize,
					verifyClaimMaxNarBytes
				);

				return {
					pendingRowsBefore,
					passRequests: passRequests.length - requestsBefore
				};
			}
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return { claims: observed, pendingRows: pendingDepth() };
	});
}

describe('cron verification D1 statement allowance', () => {
	beforeEach(resetTestServer);

	it('keeps every verification invocation within the 50-statement D1 limit', async () => {
		const driven = await driveCronVerification('verify-allowance-cron', 3);

		// All rows are committed, so the pass can use the complete maintenance
		// allowance for the scan: one statement to invalidate maintenance
		// eligibility, one probe
		// for each row of the page, and one to reconcile eligibility afterwards.
		// Every row is healthy, so the pass runs neither the committed reference
		// edge query nor a repair. The bootstrap leaves two committed paths of its
		// own beside the pushed ones, so the third pass scans 26 rows, reaches the
		// end and wraps, which resets the cursor.
		expect({
			pageSize: scanPageSize,
			committedRows: driven.committedRows,
			passStatements: driven.passes.map((pass) => pass.statements),
			overAllowancePasses: driven.passes.filter(
				(pass) => pass.statements > d1StatementsPerInvocation
			),
			statementAllowance: d1StatementsPerInvocation,
			cursors: driven.passes.map((pass) => pass.cursor)
		}).toStrictEqual({
			pageSize: 38,
			committedRows: committedPaths + 2,
			passStatements: [40, 40, 28],
			overAllowancePasses: [],
			statementAllowance: 50,
			cursors: [
				indexedMetadata(scanPageSize - 1).storePathHash,
				indexedMetadata(2 * scanPageSize - 1).storePathHash,
				''
			]
		});
	}, 240_000);
});

describe('verification claim D1 statement allowance', () => {
	beforeEach(resetTestServer);

	it('keeps every claim within the 50-statement D1 limit and settles the rest across claims', async () => {
		const driven = await driveClaims('verify-allowance-claim', 4);

		// Each claim settles two rows: two statements for maintenance eligibility,
		// two to prefetch the shared blob facts of the page, and eleven for each
		// row it settles. Each claim that leaves rows behind asks the queue for
		// another pass. The final claim empties the queue and does not request a
		// follow-up pass.
		expect({
			claimStatements: driven.claims.map((claim) => claim.statements),
			overAllowanceClaims: driven.claims.filter(
				(claim) => claim.statements > d1StatementsPerInvocation
			),
			statementAllowance: d1StatementsPerInvocation,
			pendingBefore: driven.claims.map((claim) => claim.pendingRowsBefore),
			passRequests: driven.claims.map((claim) => claim.passRequests),
			pendingRows: driven.pendingRows
		}).toStrictEqual({
			claimStatements: [26, 26, 26, 26],
			overAllowanceClaims: [],
			statementAllowance: 50,
			pendingBefore: [reuseRows, 6, 4, 2],
			passRequests: [1, 1, 1, 0],
			pendingRows: 0
		});
	}, 240_000);
});

// A queue batch at the consumer's claim ceiling. Applying every verdict in the
// invocation that accepts them would issue about eleven statements for each
// verdict and exceed the per-invocation allowance.
const recordedBatch = verifyClaimBatchSize;

type RecordObservation = MeasuredInvocation<{
	readonly kind: 'record' | 'alarm';
	readonly heldAfter: number;
}>;

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

	// A claim and a settle both ask the queue for another verification pass.
	// Record those requests instead of sending them to a real queue, which the
	// fixture's own consumer would have to drain before the gate reopened.
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

/**
 * Claims `count` deferred uploads, reports a good verdict for every one of them
 * in a single RPC, then runs up to `maxAlarms` alarms until no row is still
 * holding a verdict. Reports the D1 statement count of each complete invocation.
 *
 * Each observation is a complete invocation: one RPC call, then one alarm
 * handler call per drain pass.
 */
async function driveRecordedVerdicts(
	server: string,
	count: number,
	maxAlarms: number,
	seedPrefix: string,
	indexOffset: number
): Promise<{
	readonly claims: number;
	readonly appliedByRecord: number;
	readonly invocations: readonly RecordObservation[];
	readonly heldVerdicts: number;
	readonly pendingRows: number;
	readonly publishedPaths: number;
}> {
	const uploads = await deferFreshUploads(
		server,
		count,
		seedPrefix,
		indexOffset
	);
	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			count,
			Number.MAX_SAFE_INTEGER
		);
		const results = verifiedResults(claim.claims, uploads);
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		const local = drizzle(state.storage, {
			schema: { narInfos, pendingUploads }
		});
		const heldVerdicts = (): number =>
			local
				.select({ id: pendingUploads.id })
				.from(pendingUploads)
				.where(isNotNull(pendingUploads.recordedVerdictJson))
				.all().length;
		const pendingDepth = (): number =>
			local.select({ id: pendingUploads.id }).from(pendingUploads).all().length;
		let appliedByRecord = 0;
		// Applying a verdict opens a critical section of its own and waits for the
		// shared materialise flush, which the runtime never runs while an outer
		// input gate is held. These runs disarm the alarm around each call rather
		// than fencing them.
		const recording = await measureInvocations(state, counting, {
			attempts: 1,
			isolation: 'disarmed-alarm',
			prepare: () => state.storage.delete(maintenancePassCursorKey),
			run: async () => {
				appliedByRecord = await instance.recordVerifications(
					claim.owner,
					results
				);

				return { kind: 'record' as const, heldAfter: heldVerdicts() };
			}
		});
		const draining = await measureInvocations(state, counting, {
			attempts: maxAlarms,
			isolation: 'disarmed-alarm',
			isDue: () => heldVerdicts() > 0,
			run: async () => {
				await instance.alarm();

				return { kind: 'alarm' as const, heldAfter: heldVerdicts() };
			}
		});
		const invocations = [
			...recording,
			...draining.map((drain) => ({
				...drain,
				invocation: drain.invocation + recording.length
			}))
		];

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return {
			claims: claim.claims.length,
			appliedByRecord,
			invocations,
			heldVerdicts: heldVerdicts(),
			pendingRows: pendingDepth(),
			publishedPaths: local
				.select({ storePathHash: narInfos.storePathHash })
				.from(narInfos)
				.all().length
		};
	});
}

// A batch small enough that the whole drain fits in one test without holding the
// Durable Object's input gate for longer than it allows.
const drainedBatch = 8;

describe('recorded verdict D1 statement allowance', () => {
	beforeEach(resetTestServer);

	it('accepts a full verdict batch within the 50-statement D1 limit', async () => {
		const driven = await driveRecordedVerdicts(
			'verify-allowance-record',
			recordedBatch,
			0,
			'recorded',
			0
		);

		// Writing all 32 verdicts updates only the Durable Object's local SQLite
		// database. The complete RPC issues 22 D1 statements while applying one verdict, and the
		// other 31 verdicts remain for the drain. Each later drain invocation
		// applies one verdict in 21 statements.
		expect({
			claims: driven.claims,
			verdictsPerInvocation: Math.floor(46 / statementsPerRecordedVerdict),
			appliedByRecord: driven.appliedByRecord,
			recordStatements: driven.invocations[0]?.statements,
			overAllowanceInvocations: driven.invocations.filter(
				(invocation) => invocation.statements > d1StatementsPerInvocation
			),
			statementAllowance: d1StatementsPerInvocation,
			heldAfterRecord: driven.invocations[0]?.heldAfter
		}).toStrictEqual({
			claims: recordedBatch,
			verdictsPerInvocation: 1,
			appliedByRecord: 1,
			recordStatements: 22,
			overAllowanceInvocations: [],
			statementAllowance: 50,
			heldAfterRecord: recordedBatch - 1
		});
	}, 240_000);

	it('applies the recorded verdicts across later alarms', async () => {
		const driven = await driveRecordedVerdicts(
			'verify-allowance-drain',
			drainedBatch,
			12,
			'drained',
			100
		);

		// The RPC applies one of the eight and holds seven. Each alarm gives the
		// verdict drain a turn, which applies another one, and every upload ends up
		// published.
		expect({
			claims: driven.claims,
			appliedByRecord: driven.appliedByRecord,
			heldAfterEachInvocation: driven.invocations.map(
				(invocation) => invocation.heldAfter
			),
			statementsPerInvocation: driven.invocations.map(
				(invocation) => invocation.statements
			),
			overAllowanceInvocations: driven.invocations.filter(
				(invocation) => invocation.statements > d1StatementsPerInvocation
			),
			statementAllowance: d1StatementsPerInvocation,
			heldVerdicts: driven.heldVerdicts,
			pendingRows: driven.pendingRows,
			publishedPaths: driven.publishedPaths
		}).toStrictEqual({
			claims: drainedBatch,
			appliedByRecord: 1,
			heldAfterEachInvocation: [7, 6, 5, 4, 3, 2, 1, 0],
			statementsPerInvocation: [22, 21, 21, 21, 21, 21, 21, 21],
			overAllowanceInvocations: [],
			statementAllowance: 50,
			heldVerdicts: 0,
			pendingRows: 0,
			publishedPaths: drainedBatch
		});
	}, 240_000);
});

/**
 * Records a verdict for one deferred upload while its promotion fails. The row
 * retains the recorded verdict. Reports whether a fresh claim can take the row
 * and how the drain proceeds after promotion recovers.
 */
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

		// The promotion outage interrupts the application between accepting the
		// verdict and settling the row. The row keeps the verdict rather than the
		// consumer's decode work being lost, refuses a fresh claim while it holds
		// one, and settles exactly once when the drain retries it.
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
		await instance.recordVerifications(
			claim.owner,
			verifiedResults(claim.claims, uploads)
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
			heldAfterFirstAlarm: 1,
			heldAfterSecondAlarm: 0,
			isMalformedVerdictCleared: true,
			pendingAfterDrain: 1,
			publishedPaths: 2
		});
	}, 240_000);
});
