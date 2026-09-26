import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import {
	cacheGenerationSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStepStatus,
	type LocalStepSweep,
	type LocalStepSweepChainId,
	localStepSweepChainIdSchema,
	localStepSweepPaceSeconds,
	type LocalStepWakeBatch,
	type LocalStepWakeChain,
	type LocalStepWakeOutcome,
	type LocalStepWakeOutcomes,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import {
	maintenanceQueueMaxRetries,
	maintenanceQueueRetryDelaySeconds,
	queueConsumerWallClockMs
} from '../policy/maintenance-queue.ts';
import { executeMaintenanceQueueMessage } from '../routing/scheduled.ts';
import {
	flakyD1,
	migrateThrough,
	provisionNamedTenant,
	recordTransition,
	testServerFor
} from '../test-support.ts';

import {
	controlLocalStepPending,
	controlLocalStepStatus,
	controlLocalStepWake
} from './local-step.ts';
import {
	type LocalStepSweepContinuation,
	type LocalStepSweepMessage,
	type LocalStepSweepOptions,
	restartLocalStepSweep,
	runLocalStepSweep,
	wakeLocalStepsAndContinue
} from './local-step-chain.ts';
import {
	claimLocalStepSweep,
	type LocalStepSweepDelivery,
	localStepSweepLeaseMs,
	localStepSweepRestart,
	type LocalStepSweepRow,
	localStepSweepStallCapSeconds,
	type LocalStepSweepUpdate,
	markLocalStepSweepSent,
	readLocalStepSweep,
	recordNextLocalStepSweepLink
} from './local-step-sweep.ts';

const logger = rootLogger();
const start = new Date('2026-01-01T00:00:00.000Z');
const chainA = localStepSweepChainIdSchema.parse(
	'00000000-0000-4000-8000-00000000000a'
);
const chainB = localStepSweepChainIdSchema.parse(
	'00000000-0000-4000-8000-00000000000b'
);
const chainC = localStepSweepChainIdSchema.parse(
	'00000000-0000-4000-8000-00000000000c'
);
const pace = localStepSweepPaceSeconds;
const paceLeaseMs = localStepSweepLeaseMs(pace);
const capLeaseMs = localStepSweepLeaseMs(localStepSweepStallCapSeconds);
const dueLeaseMs = localStepSweepLeaseMs(0);

interface SentSweep {
	readonly body: LocalStepSweepMessage;
	readonly delaySeconds: number | undefined;
}

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function tenant(name: string): TenantId {
	return tenantIdSchema.parse(name);
}

function sweepQueue(
	sent: SentSweep[]
): NonNullable<LocalStepSweepOptions['queue']> {
	return {
		sendBatch: (batch) => {
			for (const { body, delaySeconds } of batch) {
				sent.push({ body, delaySeconds });
			}

			return Promise.resolve({
				metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } }
			});
		}
	};
}

function link(
	chain: LocalStepSweepChainId,
	index: number
): LocalStepSweepMessage {
	return { kind: 'local-step-sweep', chain: { chain, link: index } };
}

function delivery(id: string, attempts = 1): LocalStepSweepDelivery {
	return { id, attempts };
}

function chained(
	chain: LocalStepSweepChainId,
	index: number,
	delaySeconds = pace
): SentSweep {
	return { body: link(chain, index), delaySeconds };
}

function sentNext(
	chain: LocalStepSweepChainId,
	index: number,
	state: 'running' | 'stalled' = 'running',
	delaySeconds = pace
): LocalStepSweepContinuation {
	return {
		kind: 'sent',
		next: { chain, link: index },
		state,
		delaySeconds
	};
}

// Delivers a sweep message through the maintenance consumer's dispatch, with
// the sweep's batch size and queue replaced so a handful of tenants make a
// backlog.
function deliver(
	message: LocalStepSweepMessage,
	options: LocalStepSweepOptions,
	received: LocalStepSweepDelivery,
	sweepEnv: Env = env
): ReturnType<typeof executeMaintenanceQueueMessage> {
	return executeMaintenanceQueueMessage(
		logger,
		sweepEnv,
		{ ...message, delivery: received },
		{
			runLocalStepSweep: (sweepLogger, runEnv, chain, runDelivery) =>
				runLocalStepSweep(sweepLogger, runEnv, chain, runDelivery, options)
		}
	);
}

type NullableColumn = 'batchMessage' | 'batchAttempts' | 'stalledAt' | 'nextAt';

// The row with each null column left out, so an expectation lists only the
// columns that have values.
type StoredRow = Omit<LocalStepSweepRow, NullableColumn> & {
	readonly [Column in NullableColumn]?: NonNullable<LocalStepSweepRow[Column]>;
};

async function sweepRow(): Promise<StoredRow | undefined> {
	const row = await database().select().from(d1Schema.localStepSweep).get();

	if (row === undefined) {
		return undefined;
	}

	const { batchMessage, batchAttempts, stalledAt, nextAt, ...columns } = row;

	return {
		...columns,
		...(batchMessage !== null && { batchMessage }),
		...(batchAttempts !== null && { batchAttempts }),
		...(stalledAt !== null && { stalledAt }),
		...(nextAt !== null && { nextAt })
	};
}

// A row as a chain writes it, with the columns that most tests leave at their
// values for a running chain whose link was sent.
function expectedRow(
	fields: Pick<
		StoredRow,
		'chain' | 'link' | 'expiresAt' | 'updatedAt' | 'batchAt'
	> &
		Partial<Omit<StoredRow, 'lastOutcomes'>> & {
			readonly outcomes: LocalStepWakeOutcomes;
		}
): StoredRow {
	const { outcomes, ...columns } = fields;

	return {
		id: 1,
		sent: true,
		wokenWithoutWork: 0,
		failingTenants: '[]',
		delaySeconds: pace,
		lastOutcomes: JSON.stringify(outcomes),
		...columns
	};
}

async function provisionTenants(
	names: readonly string[],
	shouldConfigure = true
): Promise<void> {
	for (const name of names) {
		await provisionNamedTenant(name, { configure: shouldConfigure });
	}
}

function instant(offsetMs: number): IsoTimestamp {
	return isoTimestamp(new Date(start.getTime() + offsetMs));
}

type SweepProgress = Pick<
	LocalStepSweepUpdate,
	'wokenWithoutWork' | 'stalledAt' | 'delaySeconds'
>;

// Claims the row for a chain and records its first message as sent, as a chain
// that has just started leaves it.
async function claimChain(
	chain: LocalStepSweepChainId,
	outcomes: LocalStepWakeOutcomes = [],
	progress: Partial<SweepProgress> = {}
): Promise<void> {
	const update: LocalStepSweepUpdate = {
		...localStepSweepRestart({ outcomes, batchAt: isoTimestamp(new Date()) }),
		...progress
	};
	const first = await claimLocalStepSweep(
		database(),
		chain,
		update,
		new Date()
	);

	if (first === undefined) {
		throw new Error('another chain has the lease');
	}

	await markLocalStepSweepSent(
		database(),
		first,
		update.delaySeconds,
		new Date()
	);
}

function recorded(name: string, step = currentLocalStep) {
	return {
		tenant: tenant(name),
		kind: 'recorded' as const,
		step,
		progressed: true
	};
}

// A wake that completed and did no work.
function withoutWork(name: string): LocalStepWakeOutcome {
	return {
		tenant: tenant(name),
		kind: 'advanced',
		projected: 0,
		progressed: false,
		step: expansionLocalStep
	};
}

function failed(name: string): LocalStepWakeOutcome {
	return {
		tenant: tenant(name),
		kind: 'failed',
		error: 'Error: tenant object unavailable'
	};
}

// A wake whose batches are scripted, so a test can choose which batches
// advance a tenant while the real tenants keep the pending count above zero.
function scriptedWake(
	batches: readonly LocalStepWakeBatch[]
): NonNullable<LocalStepSweepOptions['wake']> {
	let index = 0;

	return () => {
		const batch = batches[index];
		index += 1;

		if (batch === undefined) {
			throw new Error(`no scripted batch ${String(index)}`);
		}

		return Promise.resolve(batch);
	};
}

// The real wake, counting how often a sweep runs a batch.
function countingWake(wakes: {
	count: number;
}): NonNullable<LocalStepSweepOptions['wake']> {
	return (wakeLogger, wakeEnv, limit) => {
		wakes.count += 1;

		return controlLocalStepWake(wakeLogger, wakeEnv, limit);
	};
}

class QueueUnavailableError extends Error {
	constructor() {
		super('queue unavailable');
		this.name = 'QueueUnavailableError';
	}
}

class D1FaultError extends Error {
	constructor() {
		super('injected D1 fault');
		this.name = 'D1FaultError';
	}
}

function stallBatch(...outcomes: LocalStepWakeOutcomes): LocalStepWakeBatch {
	return {
		current: currentLocalStep,
		required: currentLocalStep,
		woken: 0,
		failed: outcomes.length,
		outcomes
	};
}

function progressBatch(...outcomes: LocalStepWakeOutcomes): LocalStepWakeBatch {
	return {
		current: currentLocalStep,
		required: currentLocalStep,
		woken: outcomes.length,
		failed: 0,
		outcomes
	};
}

// Runs consecutive links of a chain one after another, because each link reads
// the row that the link before it wrote.
function runLinks(
	chain: LocalStepSweepChainId,
	links: readonly number[],
	options: LocalStepSweepOptions
): Promise<LocalStepSweepContinuation[]> {
	return Array.fromAsync(links, (index) => {
		const received = delivery(`link-${String(index)}`);

		return runLocalStepSweep(
			logger,
			env,
			{ chain, link: index },
			received,
			options
		);
	});
}

function unconfigured(name: string): LocalStepWakeOutcomes {
	return [{ tenant: tenant(name), kind: 'unconfigured' }];
}

describe('local step sweep chain', () => {
	beforeEach(async () => {
		await recordTransition('cache-identity', 'complete');
	});

	it('drains a pending backlog through chained messages from the cron tick', async () => {
		await provisionTenants([
			'drain-a',
			'drain-b',
			'drain-c',
			'drain-d',
			'drain-e'
		]);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			batchSize: 2,
			queue: sweepQueue(sent),
			newChain: () => chainA
		};

		const started = await restartLocalStepSweep(logger, env, options);
		const decisions: unknown[] = [];
		// Each delivery may append the chain's next message to `sent` during the
		// loop.
		for (const [index, message] of sent.entries()) {
			const received = delivery(`sent-${String(index)}`);
			decisions.push(await deliver(message.body, options, received));
		}
		const row = await sweepRow();
		// The acknowledgement of the last message is lost, and the queue delivers
		// it again after the chain has ended.
		const redelivered = await runLocalStepSweep(
			logger,
			env,
			{ chain: chainA, link: 2 },
			delivery('sent-2', 2),
			options
		);

		expect({
			started,
			decisions,
			redelivered,
			sent,
			pending: await controlLocalStepPending(env),
			row,
			sweep: await readLocalStepSweep(logger, database(), new Date())
		}).toStrictEqual({
			started: sentNext(chainA, 0),
			decisions: [{ action: 'ack' }, { action: 'ack' }, { action: 'ack' }],
			redelivered: { kind: 'superseded' },
			sent: [chained(chainA, 0), chained(chainA, 1), chained(chainA, 2)],
			pending: 0,
			row: expectedRow({
				chain: chainA,
				link: 2,
				batchMessage: 'sent-2',
				batchAttempts: 1,
				expiresAt: instant(0),
				updatedAt: instant(0),
				batchAt: instant(0),
				outcomes: [recorded('drain-e')]
			}),
			sweep: {
				state: 'idle',
				last: {
					chain: chainA,
					link: 2,
					updatedAt: instant(0),
					batchAt: instant(0),
					outcomes: [recorded('drain-e')],
					failing: []
				}
			}
		});
	});

	it('starts one chain when two restarts run at the same time', async () => {
		await provisionTenants(['race-a', 'race-b']);
		const sent: SentSweep[] = [];
		const starts = await Promise.all(
			[chainA, chainB].map((chain) =>
				restartLocalStepSweep(logger, env, {
					queue: sweepQueue(sent),
					newChain: () => chain
				})
			)
		);
		const started = await sweepRow();

		expect({
			kinds: starts
				.map((start) => start.kind)
				.toSorted((left, right) => left.localeCompare(right)),
			sent: sent.map((message) => message.body.chain.chain),
			isStartedChainSent:
				started !== undefined &&
				sent.some((message) => message.body.chain.chain === started.chain)
		}).toStrictEqual({
			kinds: ['held-elsewhere', 'sent'],
			sent: [started?.chain],
			isStartedChainSent: true
		});
	});

	it('starts no second chain while another chain has the lease', async () => {
		await provisionTenants(['held-a', 'held-b', 'held-c']);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			batchSize: 1,
			queue: sweepQueue(sent),
			newChain: () => chainB
		};

		const whileHeld = await restartLocalStepSweep(logger, env, options);
		const heldRow = await sweepRow();
		const sentWhileHeld = [...sent];
		vi.setSystemTime(new Date(start.getTime() + paceLeaseMs));
		const afterExpiry = await restartLocalStepSweep(logger, env, options);

		expect({
			whileHeld,
			heldRow,
			sentWhileHeld,
			afterExpiry,
			sent,
			row: await sweepRow()
		}).toStrictEqual({
			whileHeld: { kind: 'held-elsewhere' },
			heldRow: expectedRow({
				chain: chainA,
				link: 0,
				expiresAt: instant(paceLeaseMs),
				nextAt: instant(pace * 1000),
				updatedAt: instant(0),
				batchAt: instant(0),
				outcomes: []
			}),
			sentWhileHeld: [],
			afterExpiry: sentNext(chainB, 0),
			sent: [chained(chainB, 0)],
			row: expectedRow({
				chain: chainB,
				link: 0,
				expiresAt: instant(2 * paceLeaseMs),
				nextAt: instant(paceLeaseMs + pace * 1000),
				updatedAt: instant(paceLeaseMs),
				batchAt: instant(0),
				outcomes: []
			})
		});
	});

	it('runs one batch and sends one next message when a message is delivered again', async () => {
		await provisionTenants(['again-a', 'again-b', 'again-c', 'again-d']);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		let wakes = 0;
		const options: LocalStepSweepOptions = {
			batchSize: 1,
			queue: sweepQueue(sent),
			newChain: () => chainB,
			wake: (wakeLogger, wakeEnv, limit) => {
				wakes += 1;

				if (wakes === 1) {
					return Promise.reject(new D1FaultError());
				}

				return controlLocalStepWake(wakeLogger, wakeEnv, limit);
			}
		};

		const failed = await deliver(link(chainA, 0), options, delivery('message'));
		// A second copy of the message arrives while the first copy's claim on
		// the batch stands.
		const copy = await deliver(link(chainA, 0), options, delivery('copy'));
		// The queue's last redelivery starts after every earlier attempt has run
		// for as long as the consumer allows and waited out its retry delay. The
		// cron tick runs in the meantime.
		const lastRedelivery =
			pace * 1000 +
			maintenanceQueueMaxRetries *
				(queueConsumerWallClockMs + maintenanceQueueRetryDelaySeconds * 1000);
		const leased = await sweepRow();
		vi.setSystemTime(new Date(start.getTime() + lastRedelivery));
		const tick = await restartLocalStepSweep(logger, env, options);
		const redelivered = await deliver(
			link(chainA, 0),
			options,
			delivery('message', maintenanceQueueMaxRetries + 1)
		);
		const duplicate = await runLocalStepSweep(
			logger,
			env,
			{ chain: chainA, link: 0 },
			delivery('message', maintenanceQueueMaxRetries + 1),
			options
		);

		expect({
			failed,
			copy,
			// The lease has not expired when the last redelivery ends, so no other
			// chain can claim the row while that delivery runs.
			isLeasedThroughLastRedelivery:
				leased !== undefined &&
				Date.parse(leased.expiresAt) >
					start.getTime() + lastRedelivery + queueConsumerWallClockMs,
			tick,
			redelivered,
			duplicate,
			wakes,
			sent,
			row: await sweepRow()
		}).toStrictEqual({
			failed: {
				action: 'retry',
				delaySeconds: maintenanceQueueRetryDelaySeconds,
				reason: 'D1FaultError: injected D1 fault'
			},
			copy: { action: 'ack' },
			isLeasedThroughLastRedelivery: true,
			tick: { kind: 'held-elsewhere' },
			redelivered: { action: 'ack' },
			duplicate: { kind: 'superseded' },
			wakes: 2,
			sent: [chained(chainA, 1)],
			row: expectedRow({
				chain: chainA,
				link: 1,
				expiresAt: instant(lastRedelivery + paceLeaseMs),
				nextAt: instant(lastRedelivery + pace * 1000),
				updatedAt: instant(lastRedelivery),
				batchAt: instant(lastRedelivery),
				outcomes: [recorded('again-a')]
			})
		});
	});

	it('runs one batch when two copies of a message are delivered at the same time', async () => {
		await provisionTenants(['overlap-a', 'overlap-b', 'overlap-c']);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const wakes = { count: 0 };
		const release = Promise.withResolvers<undefined>();
		const options: LocalStepSweepOptions = {
			batchSize: 1,
			queue: sweepQueue(sent),
			// The copy that claims the batch waits in its wake until the other
			// copy has finished, so the two deliveries overlap.
			wake: async (wakeLogger, wakeEnv, limit) => {
				wakes.count += 1;
				await release.promise;

				return controlLocalStepWake(wakeLogger, wakeEnv, limit);
			}
		};

		const copies = ['copy-a', 'copy-b'].map((id) =>
			runLocalStepSweep(
				logger,
				env,
				{ chain: chainA, link: 0 },
				delivery(id),
				options
			)
		);
		const firstToFinish = await Promise.race(copies);
		release.resolve(undefined);
		const continuations = await Promise.all(copies);

		expect({
			firstToFinish,
			kinds: continuations
				.map((continuation) => continuation.kind)
				.toSorted((left, right) => left.localeCompare(right)),
			wakes: wakes.count,
			sent
		}).toStrictEqual({
			firstToFinish: { kind: 'duplicate' },
			kinds: ['duplicate', 'sent'],
			wakes: 1,
			sent: [chained(chainA, 1)]
		});
	});

	it('starts a chain from the wake procedure while tenants remain', async () => {
		await provisionTenants(['wake-a', 'wake-b']);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			newChain: () => chainA
		};

		const first = await wakeLocalStepsAndContinue(logger, env, 1, options);
		const afterFirst = await readLocalStepSweep(logger, database(), new Date());
		const second = await wakeLocalStepsAndContinue(logger, env, 1, options);

		expect({ first, afterFirst, second, sent }).toStrictEqual({
			first: {
				current: currentLocalStep,
				required: currentLocalStep,
				woken: 1,
				failed: 0,
				outcomes: [recorded('wake-a')],
				chain: { kind: 'started', chain: chainA }
			},
			// The wake's own batch is the chain's first.
			afterFirst: {
				state: 'running',
				chain: chainA,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 0,
				outcomes: [recorded('wake-a')],
				failing: []
			},
			second: {
				current: currentLocalStep,
				required: currentLocalStep,
				woken: 1,
				failed: 0,
				outcomes: [recorded('wake-b')],
				chain: { kind: 'none' }
			},
			sent: [chained(chainA, 0)]
		});
	});

	it('confirms a stall once it has woken every pending tenant without work, and then backs off', async () => {
		await provisionTenants(['stall-a', 'stall-b', 'stall-c'], false);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			batchSize: 1,
			queue: sweepQueue(sent),
			newChain: () => chainB
		};

		const first = await runLocalStepSweep(
			logger,
			env,
			{ chain: chainA, link: 0 },
			delivery('link-0'),
			options
		);
		const afterFirst = await readLocalStepSweep(logger, database(), new Date());
		const continuations = [first];
		// Each delivery appends the chain's next message to `sent` during the
		// loop. The chain keeps retrying at the cap, so stop after the second
		// delay at the cap.
		for (const [index, message] of sent.entries()) {
			const received = delivery(`sent-${String(index)}`);
			continuations.push(
				await runLocalStepSweep(
					logger,
					env,
					message.body.chain,
					received,
					options
				)
			);

			if (
				sent.filter(
					(next) => next.delaySeconds === localStepSweepStallCapSeconds
				).length === 2
			) {
				break;
			}
		}

		expect({
			afterFirst,
			continuations: continuations.map((continuation) =>
				continuation.kind === 'sent'
					? [continuation.state, continuation.delaySeconds]
					: continuation.kind
			),
			sentDelays: sent.map((message) => message.delaySeconds),
			pending: await controlLocalStepPending(env),
			row: await sweepRow()
		}).toStrictEqual({
			afterFirst: {
				state: 'running',
				chain: chainA,
				link: 1,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 1,
				outcomes: unconfigured('stall-a'),
				failing: []
			},
			// The third batch completes a pass over the three pending tenants.
			continuations: [
				['running', 10],
				['running', 10],
				['stalled', 20],
				['stalled', 40],
				['stalled', 80],
				['stalled', 160],
				['stalled', 320],
				['stalled', 640],
				['stalled', 1280],
				['stalled', 2560],
				['stalled', 3600],
				['stalled', 3600]
			],
			sentDelays: [10, 10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600, 3600],
			pending: 3,
			row: expectedRow({
				chain: chainA,
				link: 12,
				wokenWithoutWork: 12,
				stalledAt: instant(0),
				delaySeconds: localStepSweepStallCapSeconds,
				expiresAt: instant(capLeaseMs),
				nextAt: instant(localStepSweepStallCapSeconds * 1000),
				updatedAt: instant(0),
				batchAt: instant(0),
				outcomes: unconfigured('stall-c')
			})
		});
	});

	it('clears the stall when a tenant does work in a batch', async () => {
		await provisionTenants(['reset-a'], false);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const idle = withoutWork('reset-a');
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			wake: scriptedWake([
				stallBatch(idle),
				stallBatch(idle),
				progressBatch(recorded('reset-b')),
				stallBatch(idle),
				stallBatch(idle)
			])
		};

		const continuations = await runLinks(chainA, [0, 1, 2, 3, 4], options);

		expect({
			continuations,
			sentDelays: sent.map((message) => message.delaySeconds)
		}).toStrictEqual({
			// One tenant is pending, so each batch without work is a full pass.
			continuations: [
				sentNext(chainA, 1, 'stalled', 20),
				sentNext(chainA, 2, 'stalled', 40),
				sentNext(chainA, 3, 'running', 10),
				sentNext(chainA, 4, 'stalled', 20),
				sentNext(chainA, 5, 'stalled', 40)
			],
			sentDelays: [20, 40, 10, 20, 40]
		});
	});

	it('shows a stopped chain as idle once its lease expires, and the cron tick starts a new chain with the last outcomes', async () => {
		await provisionTenants(['stopped-chain-a']);
		await claimChain(chainA, [recorded('stopped-chain-b')]);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			newChain: () => chainB
		};

		const whileHeld = await controlLocalStepStatus(logger, env);
		vi.setSystemTime(new Date(start.getTime() + paceLeaseMs));
		const expired = await controlLocalStepStatus(logger, env);
		const restarted = await restartLocalStepSweep(logger, env, options);
		const afterRestart = await controlLocalStepStatus(logger, env);

		expect({
			whileHeld: whileHeld.sweep,
			expired: expired.sweep,
			restarted,
			afterRestart: afterRestart.sweep,
			sent
		}).toStrictEqual({
			whileHeld: {
				state: 'running',
				chain: chainA,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 0,
				outcomes: [recorded('stopped-chain-b')],
				failing: []
			},
			expired: {
				state: 'idle',
				last: {
					chain: chainA,
					link: 0,
					updatedAt: instant(0),
					batchAt: instant(0),
					outcomes: [recorded('stopped-chain-b')],
					failing: []
				}
			},
			restarted: sentNext(chainB, 0),
			afterRestart: {
				state: 'running',
				chain: chainB,
				link: 0,
				updatedAt: instant(paceLeaseMs),
				batchAt: instant(0),
				nextAt: instant(paceLeaseMs + pace * 1000),
				wokenWithoutWork: 0,
				outcomes: [recorded('stopped-chain-b')],
				failing: []
			},
			sent: [chained(chainB, 0)]
		});
	});

	it('reports failing tenants in the status, and stops counting a failing tenant once it is no longer pending', async () => {
		await provisionTenants(['report-unconfigured'], false);
		await provisionTenants(['report-failing']);
		await claimChain(chainA);
		const unconfiguredTenant: LocalStepWakeOutcome = {
			tenant: tenant('report-unconfigured'),
			kind: 'unconfigured'
		};
		const options: LocalStepSweepOptions = {
			queue: sweepQueue([]),
			wake: scriptedWake([
				stallBatch(unconfiguredTenant, failed('report-failing')),
				stallBatch(unconfiguredTenant)
			])
		};

		await runLinks(chainA, [0], options);
		const whileFailing = await controlLocalStepStatus(logger, env);
		// Another wake records the failing tenant's step.
		await database()
			.update(d1Schema.tenant)
			.set({ localStep: currentLocalStep })
			.where(eq(d1Schema.tenant.id, tenant('report-failing')))
			.run();
		await runLinks(chainA, [1], options);
		const afterRecorded = await controlLocalStepStatus(logger, env);

		expect({ whileFailing, afterRecorded }).toStrictEqual({
			whileFailing: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: 0,
				pending: 2,
				stragglers: [tenant('report-failing'), tenant('report-unconfigured')],
				sweep: {
					state: 'running',
					chain: chainA,
					link: 1,
					updatedAt: instant(0),
					batchAt: instant(0),
					nextAt: instant(pace * 1000),
					wokenWithoutWork: 1,
					outcomes: [unconfiguredTenant, failed('report-failing')],
					failing: [
						{
							tenant: tenant('report-failing'),
							failures: 1,
							error: 'Error: tenant object unavailable'
						}
					]
				}
			},
			afterRecorded: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: 1,
				pending: 1,
				stragglers: [tenant('report-unconfigured')],
				sweep: {
					state: 'stalled',
					chain: chainA,
					link: 2,
					updatedAt: instant(0),
					batchAt: instant(0),
					nextAt: instant(2 * pace * 1000),
					wokenWithoutWork: 2,
					stalledAt: instant(0),
					outcomes: [unconfiguredTenant],
					failing: []
				}
			}
		});
	});

	// A failed wake may not have reached the tenant, so it is neither work nor a
	// completed wake until the tenant has failed five wakes in a row.
	it.each([
		{
			name: 'keeps running through a failed wake that is followed by work',
			batches: [
				stallBatch(failed('transient-a')),
				progressBatch(recorded('transient-a'))
			],
			observed: [
				{ state: 'running', wokenWithoutWork: 0, failures: [1] },
				{ state: 'running', wokenWithoutWork: 0, failures: [] }
			]
		},
		{
			name: 'confirms a stall once a tenant has failed five wakes in a row',
			batches: Array.from({ length: 6 }, () =>
				stallBatch(failed('transient-a'))
			),
			observed: [
				{ state: 'running', wokenWithoutWork: 0, failures: [1] },
				{ state: 'running', wokenWithoutWork: 0, failures: [2] },
				{ state: 'running', wokenWithoutWork: 0, failures: [3] },
				{ state: 'running', wokenWithoutWork: 0, failures: [4] },
				{ state: 'stalled', wokenWithoutWork: 1, failures: [5] },
				{ state: 'stalled', wokenWithoutWork: 2, failures: [6] }
			]
		}
	])('$name', async ({ batches, observed: expected }) => {
		await provisionTenants(['transient-a']);
		await claimChain(chainA);
		const options: LocalStepSweepOptions = {
			queue: sweepQueue([]),
			wake: scriptedWake(batches)
		};
		const observed: unknown[] = [];

		for (const index of batches.keys()) {
			await runLinks(chainA, [index], options);
			const sweep = await readLocalStepSweep(logger, database(), new Date());
			observed.push(
				sweep.state === 'idle'
					? { state: sweep.state }
					: {
							state: sweep.state,
							wokenWithoutWork: sweep.wokenWithoutWork,
							failures: sweep.failing.map((failure) => failure.failures)
						}
			);
		}

		expect(observed).toStrictEqual(expected);
	});

	it('sends the recorded message when the queue retries a delivery whose send failed', async () => {
		await provisionTenants(['unsent-a', 'unsent-b', 'unsent-c']);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const accepting = sweepQueue(sent);
		const wakes = { count: 0 };
		let sends = 0;
		const options: LocalStepSweepOptions = {
			batchSize: 1,
			wake: countingWake(wakes),
			queue: {
				sendBatch: (batch) => {
					sends += 1;

					return sends === 1
						? Promise.reject(new QueueUnavailableError())
						: accepting.sendBatch(batch);
				}
			}
		};
		const retryDelayMs = maintenanceQueueRetryDelaySeconds * 1000;

		const failed = await deliver(link(chainA, 0), options, delivery('message'));
		const afterFailure = await sweepRow();
		vi.setSystemTime(new Date(start.getTime() + retryDelayMs));
		const redelivered = await deliver(
			link(chainA, 0),
			options,
			delivery('message', 2)
		);
		const duplicate = await deliver(
			link(chainA, 0),
			options,
			delivery('message', 3)
		);

		expect({
			failed,
			afterFailure,
			redelivered,
			duplicate,
			wakes: wakes.count,
			sent,
			row: await sweepRow()
		}).toStrictEqual({
			failed: {
				action: 'retry',
				delaySeconds: maintenanceQueueRetryDelaySeconds,
				reason: 'QueueUnavailableError: queue unavailable'
			},
			afterFailure: expectedRow({
				chain: chainA,
				link: 1,
				sent: false,
				expiresAt: instant(paceLeaseMs),
				nextAt: instant(pace * 1000),
				updatedAt: instant(0),
				batchAt: instant(0),
				outcomes: [recorded('unsent-a')]
			}),
			redelivered: { action: 'ack' },
			duplicate: { action: 'ack' },
			wakes: 1,
			// The message was due before the redelivery, so it is sent without a
			// delay.
			sent: [chained(chainA, 1, 0)],
			row: expectedRow({
				chain: chainA,
				link: 1,
				expiresAt: instant(retryDelayMs + dueLeaseMs),
				nextAt: instant(pace * 1000),
				updatedAt: instant(0),
				batchAt: instant(0),
				outcomes: [recorded('unsent-a')]
			})
		});
	});

	it('sends the recorded message when a delivery stopped before sending it', async () => {
		await provisionTenants(['stopped-a', 'stopped-b']);
		await claimChain(chainA);
		// The first delivery of link 0 ran its batch and recorded link 1, then
		// stopped before it sent the message for link 1.
		await recordNextLocalStepSweepLink(
			database(),
			{ chain: chainA, link: 0 },
			localStepSweepRestart({
				outcomes: [recorded('stopped-a')],
				batchAt: instant(0)
			}),
			new Date()
		);
		const sent: SentSweep[] = [];
		const wakes = { count: 0 };
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			wake: countingWake(wakes)
		};

		const redelivered = await deliver(
			link(chainA, 0),
			options,
			delivery('message', 2)
		);

		expect({
			redelivered,
			wakes: wakes.count,
			sent,
			row: await sweepRow()
		}).toStrictEqual({
			redelivered: { action: 'ack' },
			wakes: 0,
			sent: [chained(chainA, 1)],
			row: expectedRow({
				chain: chainA,
				link: 1,
				expiresAt: instant(paceLeaseMs),
				nextAt: instant(pace * 1000),
				updatedAt: instant(0),
				batchAt: instant(0),
				outcomes: [recorded('stopped-a')]
			})
		});
	});

	it('ends a new chain when its first message cannot be sent', async () => {
		await provisionTenants(['first-a']);
		const sendFault = new QueueUnavailableError();
		const options: LocalStepSweepOptions = {
			newChain: () => chainA,
			queue: { sendBatch: () => Promise.reject(sendFault) }
		};

		await expect(restartLocalStepSweep(logger, env, options)).rejects.toBe(
			sendFault
		);
		await expect(
			readLocalStepSweep(logger, database(), new Date())
		).resolves.toStrictEqual({
			state: 'idle',
			last: {
				chain: chainA,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				outcomes: [],
				failing: []
			}
		});
	});

	// The row keeps the unsent first link until its lease expires, so the caller
	// needs both errors to see why no chain runs.
	it('reports both errors when it can neither send a first message nor end the chain', async () => {
		await provisionTenants(['first-b']);
		const sendFault = new QueueUnavailableError();
		const endFault = new D1FaultError();
		const failingEnv = {
			...env,
			CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, {
				failures: 1,
				error: endFault,
				matches: (query) =>
					query.startsWith('update "local_step_sweep" set "expires_at"')
			})
		};
		const options: LocalStepSweepOptions = {
			newChain: () => chainA,
			queue: { sendBatch: () => Promise.reject(sendFault) }
		};
		let caught: unknown;

		try {
			await restartLocalStepSweep(logger, failingEnv, options);
		} catch (error) {
			caught = error;
		}

		const sweep = await readLocalStepSweep(logger, database(), new Date());

		expect({
			isAggregate: caught instanceof AggregateError,
			errors: caught instanceof AggregateError ? caught.errors : undefined,
			sweep: sweep.state
		}).toStrictEqual({
			isAggregate: true,
			errors: [sendFault, endFault],
			sweep: 'running'
		});
	});

	it('ignores the writes and the next message of a chain that a wake replaced', async () => {
		await provisionTenants(['replace-a', 'replace-b']);
		await claimChain(chainA, [failed('replace-a')], {
			wokenWithoutWork: 10,
			stalledAt: instant(0),
			delaySeconds: localStepSweepStallCapSeconds
		});
		const sent: SentSweep[] = [];
		const wakes = { count: 0 };
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			newChain: () => chainB,
			wake: countingWake(wakes)
		};

		const woken = await wakeLocalStepsAndContinue(logger, env, 1, options);
		// A delivery of the stalled chain marks its link as sent after the new
		// chain has started.
		await markLocalStepSweepSent(
			database(),
			{ chain: chainA, link: 0 },
			localStepSweepStallCapSeconds,
			new Date()
		);
		const status = await controlLocalStepStatus(logger, env);
		// The stalled chain's message arrives after the new chain has started.
		const stalledMessage = await deliver(
			link(chainA, 0),
			options,
			delivery('stalled-chain')
		);

		expect({
			woken,
			sweep: status.sweep,
			stalledMessage,
			wakes: wakes.count,
			sent
		}).toStrictEqual({
			woken: {
				current: currentLocalStep,
				required: currentLocalStep,
				woken: 1,
				failed: 0,
				outcomes: [recorded('replace-a')],
				chain: { kind: 'started', chain: chainB }
			},
			sweep: {
				state: 'running',
				chain: chainB,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 0,
				outcomes: [recorded('replace-a')],
				failing: []
			},
			stalledMessage: { action: 'ack' },
			wakes: 1,
			sent: [chained(chainB, 0)]
		});
	});

	// The wake replaces the stalled chain while the stalled chain's batch runs.
	// That batch then records nothing, whether tenants remain or not.
	it.each([
		{ name: 'tenants remain', pending: 1 },
		{ name: 'no tenant remains', pending: 0 }
	])(
		'leaves the new chain in place when a replaced chain finishes its batch and $name',
		async ({ pending }) => {
			await provisionTenants(['race-a', 'race-b']);
			await claimChain(chainA, [], {
				wokenWithoutWork: 10,
				stalledAt: instant(0),
				delaySeconds: localStepSweepStallCapSeconds
			});
			const sent: SentSweep[] = [];
			const wakeOptions: LocalStepSweepOptions = {
				queue: sweepQueue(sent),
				newChain: () => chainB,
				wake: scriptedWake([progressBatch(recorded('race-a'))])
			};
			let woken: LocalStepWakeResponse | undefined;
			const stalledOptions: LocalStepSweepOptions = {
				queue: sweepQueue(sent),
				countPending: () => Promise.resolve(pending),
				wake: async () => {
					woken = await wakeLocalStepsAndContinue(logger, env, 1, wakeOptions);

					return stallBatch(withoutWork('race-b'));
				}
			};

			const continuation = await runLocalStepSweep(
				logger,
				env,
				{ chain: chainA, link: 0 },
				delivery('stalled-chain'),
				stalledOptions
			);
			const row = await sweepRow();

			expect({
				continuation,
				chain: woken?.chain,
				row: { chain: row?.chain, link: row?.link },
				sent
			}).toStrictEqual({
				continuation: { kind: 'superseded' },
				chain: { kind: 'started', chain: chainB },
				row: { chain: chainB, link: 0 },
				sent: [chained(chainB, 0)]
			});
		}
	);

	it('starts one chain when two wakes replace the same stalled chain at the same time', async () => {
		await provisionTenants(['double-a', 'double-b']);
		await claimChain(chainA, [], {
			wokenWithoutWork: 10,
			stalledAt: instant(0),
			delaySeconds: localStepSweepStallCapSeconds
		});
		const sent: SentSweep[] = [];
		const wakeWith = (chain: LocalStepSweepChainId) => {
			const options: LocalStepSweepOptions = {
				queue: sweepQueue(sent),
				newChain: () => chain,
				wake: scriptedWake([progressBatch(recorded('double-a'))])
			};

			return wakeLocalStepsAndContinue(logger, env, 1, options);
		};

		const responses = await Promise.all([wakeWith(chainB), wakeWith(chainC)]);
		const row = await sweepRow();
		const started = responses.flatMap((response) =>
			response.chain.kind === 'started' ? [response.chain.chain] : []
		);

		expect({
			kinds: responses
				.map((response) => response.chain.kind)
				.toSorted((left, right) => left.localeCompare(right)),
			sent: sent.map((message) => message.body.chain),
			isRowStarted: started.length === 1 && row?.chain === started[0]
		}).toStrictEqual({
			kinds: ['kept', 'started'],
			sent: [{ chain: started[0], link: 0 }],
			isRowStarted: true
		});
	});

	it.each([
		{
			name: 'records an outcome kind that this build does not define',
			lastOutcomes: JSON.stringify([
				{ tenant: 'rollback-a', kind: 'deferred' }
			]),
			message: 'local step sweep outcomes have an unknown shape'
		},
		{
			name: 'records outcomes that are not JSON',
			lastOutcomes: 'not json',
			message: 'local step sweep outcomes are not JSON'
		}
	])(
		'reports no outcomes when the row $name, until the next batch writes the row',
		async ({ lastOutcomes, message }) => {
			await provisionTenants(['rollback-a', 'rollback-b']);
			await claimChain(chainA);
			await database()
				.update(d1Schema.localStepSweep)
				.set({ lastOutcomes })
				.run();
			const capture = startCapture();
			let before: LocalStepStatus;

			try {
				before = await controlLocalStepStatus(logger, env);
			} finally {
				capture.stop();
			}
			await runLinks(chainA, [0], { batchSize: 1, queue: sweepQueue([]) });
			const after = await controlLocalStepStatus(logger, env);

			expect({
				before: before.sweep,
				logged: capture.logs
					.filter((entry) => entry.level !== 'debug')
					.map((entry) => ({
						level: entry.level,
						message: entry.message,
						chain: entry.properties.chain,
						link: entry.properties.link
					})),
				after: after.sweep
			}).toStrictEqual({
				before: {
					state: 'running',
					chain: chainA,
					link: 0,
					updatedAt: instant(0),
					batchAt: instant(0),
					nextAt: instant(pace * 1000),
					wokenWithoutWork: 0,
					outcomes: [],
					failing: []
				},
				logged: [{ level: 'warning', message, chain: chainA, link: 0 }],
				after: {
					state: 'running',
					chain: chainA,
					link: 1,
					updatedAt: instant(0),
					batchAt: instant(0),
					nextAt: instant(pace * 1000),
					wokenWithoutWork: 0,
					outcomes: [recorded('rollback-a')],
					failing: []
				}
			});
		}
	);

	const busyChain = {
		chain: chainA,
		link: 3,
		updatedAt: instant(0),
		batchAt: instant(0),
		failing: []
	};

	it.each([
		{
			name: 'confirms a stall while a tenant reports more work and does none on every wake',
			projected: 0,
			isProgressed: false,
			continuations: [
				sentNext(chainA, 1, 'stalled', 20),
				sentNext(chainA, 2, 'stalled', 40),
				sentNext(chainA, 3, 'stalled', 80)
			],
			sweep: {
				state: 'stalled',
				...busyChain,
				nextAt: instant(80 * 1000),
				wokenWithoutWork: 3,
				stalledAt: instant(0)
			}
		},
		{
			name: 'keeps running while a large tenant projects caches on every wake',
			projected: 36,
			isProgressed: true,
			continuations: [
				sentNext(chainA, 1),
				sentNext(chainA, 2),
				sentNext(chainA, 3)
			],
			sweep: {
				state: 'running',
				...busyChain,
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 0
			}
		},
		{
			name: 'keeps running while a tenant migrates on every wake without projecting caches',
			projected: 0,
			isProgressed: true,
			continuations: [
				sentNext(chainA, 1),
				sentNext(chainA, 2),
				sentNext(chainA, 3)
			],
			sweep: {
				state: 'running',
				...busyChain,
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 0
			}
		}
	])(
		'$name',
		async ({ projected, isProgressed, continuations: expected, sweep }) => {
			await provisionTenants(['busy-a']);
			await claimChain(chainA);
			const busy: LocalStepWakeOutcomes = [
				{
					tenant: tenant('busy-a'),
					kind: 'advanced',
					projected,
					progressed: isProgressed,
					step: 3
				}
			];
			const options: LocalStepSweepOptions = {
				queue: sweepQueue([]),
				wake: scriptedWake([
					progressBatch(...busy),
					progressBatch(...busy),
					progressBatch(...busy)
				])
			};

			const continuations = await runLinks(chainA, [0, 1, 2], options);

			expect({
				continuations,
				sweep: await readLocalStepSweep(logger, database(), new Date())
			}).toStrictEqual({
				continuations: expected,
				sweep: { ...sweep, outcomes: busy }
			});
		}
	);

	// The tenant re-records a step below the required step on every wake, as a
	// tenant Worker from an older build would. Recording the same step again
	// moves nothing forward.
	it('confirms a stall when a tenant keeps recording a step below the required step', async () => {
		await provisionTenants(['below-a'], false);
		await claimChain(chainA);
		const again: LocalStepWakeOutcome = {
			tenant: tenant('below-a'),
			kind: 'recorded',
			step: expansionLocalStep,
			progressed: false
		};
		const options: LocalStepSweepOptions = {
			queue: sweepQueue([]),
			wake: scriptedWake(Array.from({ length: 5 }, () => progressBatch(again)))
		};

		await runLinks(chainA, [0, 1, 2, 3, 4], options);

		await expect(
			readLocalStepSweep(logger, database(), new Date())
		).resolves.toStrictEqual({
			state: 'stalled',
			chain: chainA,
			link: 5,
			updatedAt: instant(0),
			batchAt: instant(0),
			nextAt: instant(320 * 1000),
			wokenWithoutWork: 5,
			stalledAt: instant(0),
			outcomes: [again],
			failing: []
		});
	});

	it('keeps a new chain when marking its first message as sent fails', async () => {
		await provisionTenants(['mark-a', 'mark-b']);
		const sent: SentSweep[] = [];
		const markFault = new D1FaultError();
		const failingEnv = {
			...env,
			CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, {
				failures: 1,
				error: markFault,
				matches: (query) =>
					query.startsWith('update "local_step_sweep" set "sent"')
			})
		};
		const options: LocalStepSweepOptions = {
			batchSize: 1,
			queue: sweepQueue(sent),
			newChain: () => chainA
		};

		await expect(
			restartLocalStepSweep(logger, failingEnv, options)
		).rejects.toBe(markFault);
		const afterRestart = await readLocalStepSweep(
			logger,
			database(),
			new Date()
		);
		const delivered = await deliver(
			link(chainA, 0),
			options,
			delivery('first')
		);

		expect({ afterRestart, delivered, sent }).toStrictEqual({
			afterRestart: {
				state: 'running',
				chain: chainA,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 0,
				outcomes: [],
				failing: []
			},
			delivered: { action: 'ack' },
			sent: [chained(chainA, 0), chained(chainA, 1)]
		});
	});

	it('sends the next message twice when marking it as sent fails, and runs one batch for it', async () => {
		await provisionTenants(['twice-a', 'twice-b', 'twice-c']);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const wakes = { count: 0 };
		const failingEnv = {
			...env,
			CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, {
				failures: 1,
				error: new D1FaultError(),
				matches: (query) =>
					query.startsWith('update "local_step_sweep" set "sent"')
			})
		};
		const options: LocalStepSweepOptions = {
			batchSize: 1,
			queue: sweepQueue(sent),
			wake: countingWake(wakes)
		};

		const failed = await deliver(
			link(chainA, 0),
			options,
			delivery('first'),
			failingEnv
		);
		const redelivered = await deliver(
			link(chainA, 0),
			options,
			delivery('first', 2)
		);
		const first = await deliver(link(chainA, 1), options, delivery('copy-1'));
		const second = await deliver(link(chainA, 1), options, delivery('copy-2'));

		expect({
			failed,
			redelivered,
			first,
			second,
			wakes: wakes.count,
			sent
		}).toStrictEqual({
			failed: {
				action: 'retry',
				delaySeconds: maintenanceQueueRetryDelaySeconds,
				reason: 'D1FaultError: injected D1 fault'
			},
			redelivered: { action: 'ack' },
			first: { action: 'ack' },
			second: { action: 'ack' },
			wakes: 2,
			sent: [chained(chainA, 1), chained(chainA, 1), chained(chainA, 2)]
		});
	});
});

describe('local step wake procedure', () => {
	beforeEach(async () => {
		await recordTransition('cache-identity', 'complete');
	});

	const idle = withoutWork('case-b');
	const idleToo = withoutWork('case-c');
	const progress: Record<
		'stalled' | 'without-work' | 'working',
		Partial<SweepProgress>
	> = {
		stalled: {
			wokenWithoutWork: 10,
			stalledAt: instant(0),
			delaySeconds: localStepSweepStallCapSeconds
		},
		'without-work': { wokenWithoutWork: 1 },
		working: {}
	};

	it.each([
		{
			name: 'starts a chain after a batch in which no tenant does work',
			chain: undefined,
			batch: stallBatch(idle),
			queue: 'accepts',
			countPending: 'counts',
			started: { kind: 'started', chain: chainB },
			sweep: {
				state: 'running',
				chain: chainB,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 1,
				outcomes: [idle],
				failing: []
			},
			sent: [chained(chainB, 0)]
		},
		{
			name: 'starts a stalled chain when its batch woke every pending tenant without work',
			chain: undefined,
			batch: stallBatch(idle, idleToo),
			queue: 'accepts',
			countPending: 'counts',
			started: { kind: 'started', chain: chainB },
			sweep: {
				state: 'stalled',
				chain: chainB,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(2 * pace * 1000),
				wokenWithoutWork: 2,
				stalledAt: instant(0),
				outcomes: [idle, idleToo],
				failing: []
			},
			sent: [chained(chainB, 0, 2 * pace)]
		},
		{
			name: 'replaces a stalled chain although no tenant does work in its batch',
			chain: 'stalled',
			batch: stallBatch(idle),
			queue: 'accepts',
			countPending: 'counts',
			started: { kind: 'started', chain: chainB },
			sweep: {
				state: 'running',
				chain: chainB,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 1,
				outcomes: [idle],
				failing: []
			},
			sent: [chained(chainB, 0)]
		},
		{
			name: 'keeps a chain that has not confirmed a stall, although its last batch did no work',
			chain: 'without-work',
			batch: progressBatch(recorded('case-a')),
			queue: 'accepts',
			countPending: 'counts',
			started: { kind: 'kept' },
			sweep: {
				state: 'running',
				chain: chainA,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 1,
				outcomes: [],
				failing: []
			},
			sent: []
		},
		{
			name: 'keeps a chain whose last batch did work',
			chain: 'working',
			batch: stallBatch(idle),
			queue: 'accepts',
			countPending: 'counts',
			started: { kind: 'kept' },
			sweep: {
				state: 'running',
				chain: chainA,
				link: 0,
				updatedAt: instant(0),
				batchAt: instant(0),
				nextAt: instant(pace * 1000),
				wokenWithoutWork: 0,
				outcomes: [],
				failing: []
			},
			sent: []
		},
		{
			name: 'ends a stalled chain when no tenant remains after the batch',
			chain: 'stalled',
			batch: progressBatch(recorded('case-a')),
			queue: 'accepts',
			countPending: 'none',
			started: { kind: 'none' },
			sweep: {
				state: 'idle',
				last: {
					chain: chainA,
					link: 0,
					updatedAt: instant(0),
					batchAt: instant(0),
					outcomes: [recorded('case-a')],
					failing: []
				}
			},
			sent: []
		},
		{
			name: 'reports a failed chain and ends the new chain when the queue rejects its first message',
			chain: undefined,
			batch: progressBatch(recorded('case-a')),
			queue: 'rejects',
			countPending: 'counts',
			started: {
				kind: 'failed',
				error: 'QueueUnavailableError: queue unavailable'
			},
			sweep: {
				state: 'idle',
				last: {
					chain: chainB,
					link: 0,
					updatedAt: instant(0),
					batchAt: instant(0),
					outcomes: [recorded('case-a')],
					failing: []
				}
			},
			sent: []
		},
		{
			name: 'reports a failed chain when counting the pending tenants fails',
			chain: undefined,
			batch: progressBatch(recorded('case-a')),
			queue: 'accepts',
			countPending: 'fails',
			started: { kind: 'failed', error: 'D1FaultError: injected D1 fault' },
			sweep: { state: 'idle' },
			sent: []
		}
	] satisfies {
		name: string;
		chain: keyof typeof progress | undefined;
		batch: LocalStepWakeBatch;
		queue: 'accepts' | 'rejects';
		countPending: 'counts' | 'fails' | 'none';
		started: LocalStepWakeChain;
		sweep: LocalStepSweep;
		sent: SentSweep[];
	}[])('$name', async (wakeCase) => {
		await provisionTenants(['case-b', 'case-c']);

		if (wakeCase.chain !== undefined) {
			await claimChain(chainA, [], progress[wakeCase.chain]);
		}

		const sent: SentSweep[] = [];
		const countPending = {
			counts: {},
			fails: { countPending: () => Promise.reject(new D1FaultError()) },
			none: { countPending: () => Promise.resolve(0) }
		}[wakeCase.countPending];
		const options: LocalStepSweepOptions = {
			newChain: () => chainB,
			wake: scriptedWake([wakeCase.batch]),
			queue:
				wakeCase.queue === 'accepts'
					? sweepQueue(sent)
					: { sendBatch: () => Promise.reject(new QueueUnavailableError()) },
			...countPending
		};

		const response = await wakeLocalStepsAndContinue(logger, env, 1, options);

		expect({
			response,
			sweep: await readLocalStepSweep(logger, database(), new Date()),
			sent
		}).toStrictEqual({
			response: { ...wakeCase.batch, chain: wakeCase.started },
			sweep: wakeCase.sweep,
			sent: wakeCase.sent
		});
	});
});

// Creates a tenant whose object stopped at local migration 41 with
// `cacheCount` legacy caches, so its schema migrations and catalogue
// reconciliation each need several wakes.
async function provisionLegacyCatalogueTenant(
	name: string,
	cacheCount: number
): Promise<TenantId> {
	const id = tenant(name);
	const now = isoTimestamp(new Date());
	await database().insert(d1Schema.tenant).values({
		id,
		status: 'active',
		ownerIssuer: 'https://idp.test',
		ownerSubject: 'owner',
		ownerAudience: 'cupboard',
		configVersion: 1,
		createdAt: now
	});
	await database()
		.insert(d1Schema.cacheLifecycle)
		.values({
			tenant: id,
			cacheKind: 'default',
			cacheName: sql`null`,
			access: 'public',
			generation: cacheGenerationSchema.parse(1),
			updatedAt: now
		});
	await runInDurableObject(testServerFor(name), async (_instance, state) => {
		await migrateThrough(state, 41);
		state.storage.sql.exec(
			"INSERT INTO tenant_identity (id, tenant, issuer, audience, owner_issuer, owner_subject, owner_audience, config_version) VALUES ('singleton', ?, 'https://idp.test', 'cupboard', 'https://idp.test', 'owner', 'cupboard', 1)",
			id
		);
		for (let index = 0; index < cacheCount; index++) {
			state.storage.sql.exec(
				'INSERT INTO cache (name, priority, created_at) VALUES (?, 40, ?)',
				`cache-${String(index).padStart(3, '0')}`,
				now
			);
		}
	});

	return id;
}

describe('local step sweep chain before the contract migrations', () => {
	// Until the cache-identity contract migrations run, an object reports at
	// most step 4, and the transitions require step 4. Counting the tenants
	// against the build's final step would keep the chain running for ever,
	// because no tenant can record step 5 before the contract migrations run.
	it('ends once every tenant reaches the required step', async () => {
		await provisionTenants(['step4-a', 'step4-b']);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = { queue: sweepQueue(sent) };

		const [continuation] = await runLinks(chainA, [0], options);

		expect({
			continuation,
			sent,
			status: await controlLocalStepStatus(logger, env)
		}).toStrictEqual({
			continuation: { kind: 'done' },
			sent: [],
			status: {
				current: currentLocalStep,
				required: expansionLocalStep,
				ready: 2,
				pending: 0,
				stragglers: [],
				sweep: {
					state: 'idle',
					last: {
						chain: chainA,
						link: 0,
						updatedAt: instant(0),
						batchAt: instant(0),
						outcomes: [
							recorded('step4-a', expansionLocalStep),
							recorded('step4-b', expansionLocalStep)
						],
						failing: []
					}
				}
			}
		});
	});

	// Each wake of this tenant runs a page of a schema migration or of the
	// catalogue reconciliation. None of those wakes projects a cache, but each
	// one saves progress, so the chain must not confirm a stall.
	it('keeps the chain running through queue messages while a tenant migrates over many wakes', async () => {
		const migrating = await provisionLegacyCatalogueTenant(
			'sweep-legacy-catalogue',
			80
		);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			newChain: () => chainA
		};
		const observe = async (): Promise<unknown> => {
			const { sweep } = await controlLocalStepStatus(logger, env);

			return sweep.state === 'idle'
				? { state: sweep.state, outcomes: sweep.last?.outcomes }
				: {
						state: sweep.state,
						wokenWithoutWork: sweep.wokenWithoutWork,
						outcomes: sweep.outcomes
					};
		};

		await wakeLocalStepsAndContinue(logger, env, 20, options);
		const observed = [await observe()];
		// Each delivery appends the chain's next message to `sent` during the
		// loop, until the tenant records its step and the chain ends.
		for (const [index, message] of sent.entries()) {
			await deliver(message.body, options, delivery(`sent-${String(index)}`));
			observed.push(await observe());
		}
		const migratingWake = {
			state: 'running',
			wokenWithoutWork: 0,
			outcomes: [
				{
					tenant: migrating,
					kind: 'advanced',
					projected: 0,
					progressed: true
				}
			]
		};

		expect({
			observed,
			sent: sent.length,
			pending: await controlLocalStepPending(env)
		}).toStrictEqual({
			observed: [
				...Array.from({ length: 15 }, () => migratingWake),
				{
					state: 'idle',
					outcomes: [recorded(migrating, expansionLocalStep)]
				}
			],
			sent: 15,
			pending: 0
		});
	});
});
