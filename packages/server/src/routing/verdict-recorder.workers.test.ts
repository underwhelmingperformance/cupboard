import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { pendingUploads } from '../db/schema.ts';
import { type VerificationResult } from '../do/verification-service.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { verifyClaimBatchSize, verifyClaimMaxNarBytes } from '../http/http.ts';
import {
	currentServer,
	currentServerTenant,
	deferFreshUpload,
	fetchNarInfo,
	initialise,
	pendingUploadVerdict,
	resetTestServer,
	verifyCurrentTenant,
	withoutAlarmArming
} from '../test-support.ts';

import { tenantServer } from './durable-object.ts';
import {
	type RecordRetrySchedule,
	recordRetrySchedule,
	TenantObjectCalls,
	VerdictRecorder,
	verificationConsumerBudgetMs,
	verifyTenant
} from './scheduled.ts';

function verdict(uploadId: string): VerificationResult {
	return {
		uploadId: uploadIdSchema.parse(uploadId),
		verdict: { kind: 'promoted' }
	};
}

function runtimeFault(
	flags: Readonly<Record<string, boolean>>
): Error & Readonly<Record<string, boolean>> {
	return Object.assign(new Error('runtime fault'), flags);
}

// The same number of retries as the production schedule, without its delays.
const immediateRetries: RecordRetrySchedule = {
	restart: recordRetrySchedule.restart.map(() => 0),
	other: recordRetrySchedule.other.map(() => 0)
};
const restartAttempts = recordRetrySchedule.restart.length + 1;
const otherAttempts = recordRetrySchedule.other.length + 1;

describe('VerdictRecorder', () => {
	it('coalesces verdicts added while a flush is in flight', async () => {
		const batches: VerificationResult[][] = [];
		const resolvers: ((applied: number) => void)[] = [];
		const secondBatch = Promise.withResolvers<undefined>();
		const recorder = new VerdictRecorder(rootLogger(), (results) => {
			batches.push([...results]);

			return new Promise((resolve) => {
				resolvers.push(resolve);
				if (resolvers.length === 2) {
					secondBatch.resolve(undefined);
				}
			});
		});

		// The first verdict starts a flush. The next two arrive while its RPC is in
		// flight and must share one subsequent flush.
		recorder.add(verdict('a'));
		recorder.add(verdict('b'));
		recorder.add(verdict('c'));

		resolvers.at(0)?.(1);
		await secondBatch.promise;
		resolvers.at(1)?.(2);

		const applied = await recorder.finishRecording();

		expect({ applied, batches }).toStrictEqual({
			applied: 3,
			batches: [[verdict('a')], [verdict('b'), verdict('c')]]
		});
	});

	it('heals a transient recording fault with an in-place retry', async () => {
		const batches: VerificationResult[][] = [];
		let outcomes = [
			() => Promise.reject(new Error('record outage')),
			(count: number) => Promise.resolve(count)
		];
		const recorder = new VerdictRecorder(
			rootLogger(),
			(results) => {
				batches.push([...results]);
				const outcome = outcomes.at(0);
				outcomes = outcomes.slice(1);

				return outcome === undefined
					? Promise.resolve(results.length)
					: outcome(results.length);
			},
			immediateRetries
		);

		recorder.add(verdict('a'));

		const applied = await recorder.finishRecording();

		// Retry the same batch so a transient recording failure does not require
		// decoding those uploads again.
		expect({ applied, batches }).toStrictEqual({
			applied: 1,
			batches: [[verdict('a')], [verdict('a')]]
		});
	});

	it.each([
		{
			fault: 'a Durable Object reset',
			error: runtimeFault({ durableObjectReset: true }),
			attempts: restartAttempts
		},
		{
			fault: 'a retryable runtime fault',
			error: runtimeFault({ retryable: true }),
			attempts: restartAttempts
		},
		{
			fault: 'a record call that reached its budget',
			error: new SubrequestTimeoutError('verification.record'),
			attempts: otherAttempts
		},
		{
			fault: 'an overload',
			error: runtimeFault({ retryable: true, overloaded: true }),
			attempts: 1
		},
		{
			fault: 'any other failure',
			error: new Error('record outage'),
			attempts: otherAttempts
		}
	])('stops retrying $fault when its schedule is spent', async (fault) => {
		const record = vi.fn(() => Promise.reject(fault.error));
		const recorder = new VerdictRecorder(
			rootLogger(),
			record,
			immediateRetries
		);

		recorder.add(verdict('a'));

		await expect(recorder.finishRecording()).rejects.toBe(fault.error);
		expect(record).toHaveBeenCalledTimes(fault.attempts);
	});

	it('waits the restart schedule between attempts after a reset', async () => {
		vi.useFakeTimers();

		try {
			const reset = runtimeFault({ durableObjectReset: true });
			const startedAt = Date.now();
			const attemptsAt: number[] = [];
			const recorder = new VerdictRecorder(rootLogger(), () => {
				attemptsAt.push(Date.now() - startedAt);

				return Promise.reject(reset);
			});

			recorder.add(verdict('a'));
			const rejection = expect(recorder.finishRecording()).rejects.toBe(reset);
			await vi.runAllTimersAsync();
			await rejection;

			let waited = 0;
			expect(attemptsAt).toStrictEqual([
				0,
				...recordRetrySchedule.restart.map((delayMs) => (waited += delayMs))
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	// Each schedule counts its own attempts, so an ordinary failure does not
	// spend the retries for a reset.
	it('counts each schedule separately in a run of mixed failures', async () => {
		vi.useFakeTimers();

		try {
			const faults = [
				runtimeFault({ durableObjectReset: true }),
				new Error('record outage'),
				runtimeFault({ retryable: true }),
				new Error('record outage'),
				runtimeFault({ durableObjectReset: true })
			];
			const startedAt = Date.now();
			const attemptsAt: number[] = [];
			const recorder = new VerdictRecorder(
				rootLogger(),
				(results) => {
					attemptsAt.push(Date.now() - startedAt);
					const fault = faults.shift();

					return fault === undefined
						? Promise.resolve(results.length)
						: Promise.reject(fault);
				},
				{ restart: [10, 20, 40], other: [1, 2] }
			);

			recorder.add(verdict('a'));
			const finished = recorder.finishRecording();
			await vi.runAllTimersAsync();

			expect({ applied: await finished, attemptsAt }).toStrictEqual({
				applied: 1,
				attemptsAt: [0, 10, 11, 31, 33, 73]
			});
		} finally {
			vi.useRealTimers();
		}
	});

	// Cloudflare advises against retrying an overloaded object, so the pass
	// sends no further record call, also for verdicts that finish later.
	it('stops recording for the pass after an overload', async () => {
		const overload = runtimeFault({ retryable: true, overloaded: true });
		const record = vi.fn(() => Promise.reject(overload));
		const recorder = new VerdictRecorder(
			rootLogger(),
			record,
			immediateRetries
		);

		recorder.add(verdict('a'));
		await expect(recorder.finishRecording()).rejects.toBe(overload);
		recorder.add(verdict('b'));
		await expect(recorder.finishRecording()).rejects.toBe(overload);

		expect(record.mock.calls).toStrictEqual([[[verdict('a')]]]);
	});

	// The pass deadline aborts the recorder. Its error is not a fault of the
	// object, so the recorder neither logs a retry nor waits.
	it('logs no retry when the pass deadline aborts a record call', async () => {
		const controller = new AbortController();
		const deadline = new SubrequestTimeoutError('nar.verify.batch');
		const logs = startCapture();

		try {
			const recorder = new VerdictRecorder(
				rootLogger(),
				() => {
					controller.abort(deadline);

					return Promise.reject(deadline);
				},
				immediateRetries,
				controller.signal
			);

			recorder.add(verdict('a'));
			await expect(recorder.finishRecording()).rejects.toBe(deadline);

			expect(
				logs.logs.filter(
					(log) => log.message === 'verification verdicts not recorded'
				)
			).toStrictEqual([]);
		} finally {
			logs.stop();
		}
	});

	it('records a verdict that completes after a batch has failed', async () => {
		const outage = new Error('record outage');
		const batches: VerificationResult[][] = [];
		let isDown = true;
		const recorder = new VerdictRecorder(
			rootLogger(),
			(results) => {
				batches.push([...results]);

				return isDown
					? Promise.reject(outage)
					: Promise.resolve(results.length);
			},
			immediateRetries
		);

		recorder.add(verdict('a'));
		await expect(recorder.finishRecording()).rejects.toBe(outage);

		// The next batch includes the failed verdict, once.
		isDown = false;
		recorder.add(verdict('b'));
		const applied = await recorder.finishRecording();

		expect({ applied, batches }).toStrictEqual({
			applied: 2,
			batches: [
				...Array.from({ length: otherAttempts }, () => [verdict('a')]),
				[verdict('a'), verdict('b')]
			]
		});
	});

	it('makes one attempt for each later verdict once the retries are spent', async () => {
		const outage = new Error('record outage');
		const record = vi.fn(() => Promise.reject(outage));
		const recorder = new VerdictRecorder(
			rootLogger(),
			record,
			immediateRetries
		);

		recorder.add(verdict('a'));
		await expect(recorder.finishRecording()).rejects.toBe(outage);

		recorder.add(verdict('b'));
		await expect(recorder.finishRecording()).rejects.toBe(outage);

		expect(record.mock.calls).toStrictEqual([
			...Array.from({ length: otherAttempts }, () => [[verdict('a')]]),
			[[verdict('a'), verdict('b')]]
		]);
	});

	it('returns zero when no verdict was recorded', async () => {
		const recorder = new VerdictRecorder(rootLogger(), () =>
			Promise.resolve(0)
		);

		expect(await recorder.finishRecording()).toBe(0);
	});

	it('stops a retry delay when the consumer is aborted', async () => {
		vi.useFakeTimers();

		try {
			const controller = new AbortController();
			const failure = new Error('consumer deadline');
			const started = Promise.withResolvers<undefined>();
			const record = vi.fn(() => {
				started.resolve(undefined);
				return Promise.reject(new Error('record outage'));
			});
			const recorder = new VerdictRecorder(
				rootLogger(),
				record,
				{ restart: [], other: [60_000] },
				controller.signal
			);

			recorder.add(verdict('a'));
			await started.promise;
			controller.abort(failure);

			await expect(recorder.finishRecording()).rejects.toBe(failure);
			expect({
				attempts: record.mock.calls.length,
				timers: vi.getTimerCount()
			}).toStrictEqual({ attempts: 1, timers: 0 });
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
How one call to `recordVerificationsWithinBudget` fails: before it reaches
the tenant's object, or after the object has recorded the verdicts, so that
the reply is lost.
*/
type RecordFault = 'before-call' | 'after-call';

/**
Which calls fail, numbered from one for each method. A failing
`renewVerificationClaims` call fails before it reaches the object.
*/
interface FaultPlan {
	readonly record?: (call: number) => RecordFault | undefined;
	readonly failsRenewal?: (call: number) => boolean;
	/**
	Whether the object lacks `releaseVerificationClaims`, as a tenant object
	of an earlier version does.
	*/
	readonly isReleaseMissing?: boolean;
	/**
	The budget that each record call passes to the object in place of the
	pass's remaining budget.
	*/
	readonly recordBudgetMs?: number;
}

interface FaultyTenant {
	readonly env: Env;
	readonly stubsCreated: () => number;
	readonly recordedBatches: () => readonly (readonly UploadId[])[];
	readonly renewals: () => number;
}

/**
Reads `property` from `target` for a proxy, and calls a method on `target`
itself. The proxy cannot bind the method: a stub sends every property that
it does not define, `bind` included, to the object as a call.
*/
function forwarded(target: object, property: string | symbol): unknown {
	const value: unknown = Reflect.get(target, property);

	if (typeof value !== 'function') {
		return value;
	}

	return (...parameters: unknown[]): unknown =>
		Reflect.apply(value, target, parameters);
}

/**
Gives a verification pass a tenant object whose verdict recording and claim
renewal fail with `fault` as `plan` decides. Cloudflare documents that many
exceptions leave a stub broken, so that every later call on it fails with the
same exception. A stub here behaves the same way after a fault, and only a
new stub reaches the object again.
*/
function tenantWithFaults(fault: Error, plan: FaultPlan): FaultyTenant {
	const tenant = currentServerTenant();
	const batches: UploadId[][] = [];
	let renewals = 0;
	let stubsCreated = 0;

	const faultyStub = () => {
		const stub = tenantServer(env, tenant);
		let broken: Error | undefined;

		const record = async (
			owner: string,
			results: readonly VerificationResult[],
			budgetMs: number
		) => {
			batches.push(results.map((result) => result.uploadId));

			if (broken !== undefined) {
				throw broken;
			}

			const planned = plan.record?.(batches.length);

			if (planned === 'before-call') {
				broken = fault;
				throw fault;
			}

			const result = await stub.recordVerificationsWithinBudget(
				owner,
				results,
				plan.recordBudgetMs ?? budgetMs
			);

			if (planned === 'after-call') {
				broken = fault;
				throw fault;
			}

			return result;
		};

		const areClaimsRenewed = async (
			owner: string,
			uploadIds: readonly UploadId[]
		) => {
			renewals += 1;

			if (broken !== undefined) {
				throw broken;
			}

			if (plan.failsRenewal?.(renewals) === true) {
				broken = fault;
				throw fault;
			}

			return stub.renewVerificationClaims(owner, uploadIds);
		};

		return new Proxy(stub, {
			get: (target, property) => {
				if (property === 'recordVerificationsWithinBudget') {
					return record;
				}

				if (property === 'renewVerificationClaims') {
					return areClaimsRenewed;
				}

				if (property === 'releaseVerificationClaims' && plan.isReleaseMissing) {
					return () =>
						Promise.reject(
							new TypeError(
								'The RPC receiver does not implement the method "releaseVerificationClaims".'
							)
						);
				}

				if (broken !== undefined && property !== 'then') {
					const failure = broken;

					return () => Promise.reject(failure);
				}

				return forwarded(target, property);
			}
		});
	};

	const namespace = new Proxy(env.CUPBOARD_DO, {
		get: (target, property) => {
			if (property === 'get') {
				return () => {
					stubsCreated += 1;

					return faultyStub();
				};
			}

			return forwarded(target, property);
		}
	});

	return {
		env: { ...env, CUPBOARD_DO: namespace },
		stubsCreated: () => stubsCreated,
		recordedBatches: () => batches,
		renewals: () => renewals
	};
}

async function verifyWith(faulty: FaultyTenant): Promise<unknown> {
	try {
		await verifyTenant(
			rootLogger(),
			faulty.env,
			new NarReadBufferPool(),
			currentServerTenant(),
			verifyClaimBatchSize,
			verifyClaimMaxNarBytes,
			verificationConsumerBudgetMs,
			immediateRetries
		);

		return 'verified';
	} catch (error) {
		return error;
	}
}

describe('verification pass recording', () => {
	beforeEach(resetTestServer);

	// A reset interrupts the first RPC after the object has recorded its verdict.
	// The pass retries that batch on a new stub, so the object receives the same
	// verdict twice, and still records the verdict that completes later.
	it('records every verdict when the tenant object resets during recording', async () => {
		const token = await initialise();
		const first = await deferFreshUpload(token, 'reset-first', 'a'.repeat(32));
		const second = await deferFreshUpload(
			token,
			'reset-second',
			'b'.repeat(32)
		);
		const reset = runtimeFault({ durableObjectReset: true });
		const faulty = tenantWithFaults(reset, {
			record: (call) => (call === 1 ? 'after-call' : undefined)
		});

		const outcome = await verifyWith(faulty);
		const batches = faulty.recordedBatches();

		expect({
			outcome,
			batchSizes: batches.map((batch) => batch.length),
			isRetryOfSameBatch: batches.at(0)?.at(0) === batches.at(1)?.at(0),
			uploads: [...new Set(batches.flat())].toSorted(byCodeUnit),
			stubsCreated: faulty.stubsCreated(),
			verdicts: [
				await pendingUploadVerdict(first.uploadId),
				await pendingUploadVerdict(second.uploadId)
			]
		}).toStrictEqual({
			outcome: 'verified',
			batchSizes: [1, 1, 1],
			isRetryOfSameBatch: true,
			uploads: [first.uploadId, second.uploadId].toSorted(byCodeUnit),
			stubsCreated: 2,
			verdicts: [undefined, undefined]
		});
	});

	it('releases the claims of verdicts that it could not record', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'reset-down', 'c'.repeat(32));
		const reset = runtimeFault({ durableObjectReset: true });
		const faulty = tenantWithFaults(reset, { record: () => 'before-call' });

		const outcome = await verifyWith(faulty);
		const attempts = faulty.recordedBatches().length;
		const afterFailedPass = await pendingUploadVerdict(upload.uploadId);

		// Another pass can claim the upload at once. Without the release, it would
		// wait for the six-minute claim lease to expire.
		await verifyCurrentTenant();

		expect({
			outcome,
			attempts,
			afterFailedPass,
			afterNextPass: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({
			outcome: reset,
			attempts: restartAttempts,
			afterFailedPass: 'pending',
			afterNextPass: undefined
		});
	});

	it('renews the claims on a new stub when the tenant object resets during a renewal', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'renew-reset', 'd'.repeat(32));
		const reset = runtimeFault({ durableObjectReset: true });
		const faulty = tenantWithFaults(reset, {
			failsRenewal: (call) => call === 1
		});

		const outcome = await verifyWith(faulty);

		expect({
			outcome,
			renewals: faulty.renewals(),
			stubsCreated: faulty.stubsCreated(),
			verdict: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({
			outcome: 'verified',
			renewals: 2,
			stubsCreated: 2,
			verdict: undefined
		});
	});

	it('stops the pass and releases the claims when renewals keep failing', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'renew-down', 'f'.repeat(32));
		const reset = runtimeFault({ durableObjectReset: true });
		const faulty = tenantWithFaults(reset, { failsRenewal: () => true });

		const outcome = await verifyWith(faulty);
		const renewals = faulty.renewals();
		const afterFailedPass = await pendingUploadVerdict(upload.uploadId);

		await verifyCurrentTenant();

		expect({
			outcome,
			renewals,
			recordedBatches: faulty.recordedBatches(),
			afterFailedPass,
			afterNextPass: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({
			outcome: reset,
			renewals: restartAttempts,
			recordedBatches: [],
			afterFailedPass: 'pending',
			afterNextPass: undefined
		});
	});

	it('stops after one renewal that fails for another reason, and releases the claims', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(
			token,
			'renew-refused',
			'g'.repeat(32)
		);
		const refusal = new Error('renewal refused');
		const faulty = tenantWithFaults(refusal, { failsRenewal: () => true });

		const outcome = await verifyWith(faulty);
		const renewals = faulty.renewals();

		await verifyCurrentTenant();

		expect({
			outcome,
			renewals,
			afterNextPass: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({
			outcome: refusal,
			renewals: 1,
			afterNextPass: undefined
		});
	});

	// A tenant object of an earlier version has no release RPC. The pass still
	// reports the recording failure, and the claim stays leased.
	it('keeps the claims when the tenant object has no release RPC', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'no-release', 'h'.repeat(32));
		const reset = runtimeFault({ durableObjectReset: true });
		const faulty = tenantWithFaults(reset, {
			record: () => 'before-call',
			isReleaseMissing: true
		});
		const logs = startCapture();

		try {
			const outcome = await verifyWith(faulty);
			const warnings = logs.logs
				.filter((log) => log.message === 'verification claims not released')
				.map((log) => log.properties.count);

			await verifyCurrentTenant();

			expect({
				outcome,
				warnings,
				afterNextPass: await pendingUploadVerdict(upload.uploadId)
			}).toStrictEqual({
				outcome: reset,
				warnings: [1],
				afterNextPass: 'pending'
			});
		} finally {
			logs.stop();
		}
	});

	it('replaces a broken stub once when concurrent calls fail on it', async () => {
		await initialise();
		const reset = runtimeFault({ durableObjectReset: true });
		const faulty = tenantWithFaults(reset, {
			failsRenewal: (call) => call <= 2
		});
		const tenant = new TenantObjectCalls(faulty.env, currentServerTenant());
		const { signal } = new AbortController();
		const wereClaimsRenewed = () =>
			tenant.call(signal, (server) =>
				server.renewVerificationClaims('owner', [])
			);

		const outcomes = await Promise.allSettled([
			wereClaimsRenewed(),
			wereClaimsRenewed()
		]);

		expect({
			outcomes: outcomes.map((outcome) => outcome.status),
			stubsCreated: faulty.stubsCreated()
		}).toStrictEqual({
			outcomes: ['rejected', 'rejected'],
			stubsCreated: 2
		});
	});

	// The object stores a verdict before it applies it. A record call that
	// reaches its budget while it applies the verdict therefore reports
	// `timed-out` after the verdict is stored, and the pass does not send the
	// verdict again. The verdict drain publishes the path from the stored
	// verdict. The D1 batches hang, so each record call reaches its budget.
	it('leaves a stored verdict to the drain when the record call reaches its budget', async () =>
		withoutAlarmArming(async () => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'stored-verdict',
				'j'.repeat(32)
			);
			const faulty = tenantWithFaults(new Error('unused fault'), {
				recordBudgetMs: 200
			});
			const batch = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementation(() => Promise.race([]));

			let outcome: unknown;
			try {
				outcome = await verifyWith(faulty);
			} finally {
				batch.mockRestore();
			}

			// Clear any delay that the timed-out application set, as its expiry
			// would, and run the drain.
			const afterPass = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const database = drizzle(state.storage, {
						schema: { pendingUploads }
					});
					const row = database
						.update(pendingUploads)
						.set({ settleRetryAfter: sql`null` })
						.where(eq(pendingUploads.id, upload.uploadId))
						.returning({
							verdict: pendingUploads.verdict,
							recordedVerdictJson: pendingUploads.recordedVerdictJson
						})
						.get();
					await state.storage.deleteAlarm();
					await instance.alarm();

					return {
						verdict: row.verdict,
						isVerdictStored: row.recordedVerdictJson !== null
					};
				}
			);
			const narInfo = await fetchNarInfo(upload.metadata.storePathHash);

			expect({
				outcome,
				recordCalls: faulty.recordedBatches().length,
				afterPass,
				afterDrain: await pendingUploadVerdict(upload.uploadId),
				narHash: narInfo.narHash.toString()
			}).toStrictEqual({
				outcome: 'verified',
				recordCalls: 1,
				afterPass: { verdict: 'pending', isVerdictStored: true },
				afterDrain: undefined,
				narHash: upload.metadata.narHash
			});
		}));
});
