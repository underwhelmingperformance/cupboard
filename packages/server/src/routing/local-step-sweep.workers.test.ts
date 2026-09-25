import { rootLogger } from '@cupboard/logger';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStepSweepChainId,
	localStepSweepChainIdSchema,
	localStepSweepPaceSeconds,
	type LocalStepWakeOutcomes,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	controlLocalStepPending,
	controlLocalStepStatus,
	controlLocalStepWake
} from '../control/local-step.ts';
import {
	claimLocalStepSweep,
	localStepSweepLeaseMs,
	localStepSweepStallCapSeconds,
	readLocalStepSweep
} from '../control/local-step-sweep.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { provisionNamedTenant, recordTransition } from '../test-support.ts';

import {
	type LocalStepSweepContinuation,
	type LocalStepSweepMessage,
	type LocalStepSweepOptions,
	restartLocalStepSweep,
	runLocalStepSweep,
	wakeLocalStepsAndContinue
} from './local-step-sweep.ts';
import {
	maintenanceQueueMaxRetries,
	maintenanceQueueRetryDelaySeconds,
	queueConsumerWallClockMs
} from './maintenance-queue.ts';
import { executeMaintenanceQueueMessage } from './scheduled.ts';

const logger = rootLogger();
const start = new Date('2026-01-01T00:00:00.000Z');
const chainA = localStepSweepChainIdSchema.parse(
	'00000000-0000-4000-8000-00000000000a'
);
const chainB = localStepSweepChainIdSchema.parse(
	'00000000-0000-4000-8000-00000000000b'
);
const pace = localStepSweepPaceSeconds;
const paceLeaseMs = localStepSweepLeaseMs(pace);

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

function chained(
	chain: LocalStepSweepChainId,
	index: number,
	delaySeconds = pace
): SentSweep {
	return { body: link(chain, index), delaySeconds };
}

function handedOn(
	chain: LocalStepSweepChainId,
	index: number,
	state: 'running' | 'stalled' = 'running',
	delaySeconds = pace
): LocalStepSweepContinuation {
	return {
		kind: 'handed-on',
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
	options: LocalStepSweepOptions
): ReturnType<typeof executeMaintenanceQueueMessage> {
	return executeMaintenanceQueueMessage(logger, env, message, {
		runLocalStepSweep: (sweepLogger, sweepEnv, chain) =>
			runLocalStepSweep(sweepLogger, sweepEnv, chain, options)
	});
}

type SweepRow = typeof d1Schema.localStepSweep.$inferSelect;

async function sweepRow(): Promise<SweepRow | undefined> {
	return database().select().from(d1Schema.localStepSweep).get();
}

// The row without its next message time, which a chain that ended clears and
// which is asserted on its own.
function withoutNextAt(
	row: SweepRow | undefined
): Omit<SweepRow, 'nextAt'> | undefined {
	if (row === undefined) {
		return undefined;
	}

	const { nextAt: _nextAt, ...rest } = row;

	return rest;
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

function claimChain(
	chain: LocalStepSweepChainId,
	outcomes: LocalStepWakeOutcomes = []
): Promise<unknown> {
	return claimLocalStepSweep(
		database(),
		chain,
		{ state: 'running', delaySeconds: pace, outcomes },
		new Date()
	);
}

function recorded(name: string, step = currentLocalStep) {
	return { tenant: tenant(name), kind: 'recorded' as const, step };
}

// A wake whose batches are scripted, so a test can choose which batches
// advance a tenant while the real tenants keep the pending count above zero.
function scriptedWake(
	batches: readonly LocalStepWakeResponse[]
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

function stallBatch(...outcomes: LocalStepWakeOutcomes): LocalStepWakeResponse {
	return {
		current: currentLocalStep,
		woken: 0,
		failed: outcomes.length,
		outcomes
	};
}

function progressBatch(
	...outcomes: LocalStepWakeOutcomes
): LocalStepWakeResponse {
	return {
		current: currentLocalStep,
		woken: outcomes.length,
		failed: 0,
		outcomes
	};
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
		// Each delivery may append the chain's next message while this loops.
		for (const message of sent) {
			decisions.push(await deliver(message.body, options));
		}
		const ended = await sweepRow();

		expect(ended?.nextAt).toBeNull();
		expect({
			started,
			decisions,
			sent,
			pending: await controlLocalStepPending(env),
			row: withoutNextAt(ended),
			sweep: await readLocalStepSweep(database(), new Date())
		}).toStrictEqual({
			started: handedOn(chainA, 0),
			decisions: [{ action: 'ack' }, { action: 'ack' }, { action: 'ack' }],
			sent: [chained(chainA, 0), chained(chainA, 1), chained(chainA, 2)],
			pending: 0,
			row: {
				id: 1,
				chain: chainA,
				link: 2,
				state: 'running',
				expiresAt: instant(0),
				updatedAt: instant(0),
				lastOutcomes: JSON.stringify([recorded('drain-e')])
			},
			sweep: {
				state: 'idle',
				last: {
					chain: chainA,
					link: 2,
					updatedAt: instant(0),
					outcomes: [recorded('drain-e')]
				}
			}
		});
	});

	it('starts no second chain while the lease is held', async () => {
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
			heldRow: {
				id: 1,
				chain: chainA,
				link: 0,
				state: 'running',
				expiresAt: instant(paceLeaseMs),
				nextAt: instant(pace * 1000),
				updatedAt: instant(0),
				lastOutcomes: '[]'
			},
			sentWhileHeld: [],
			afterExpiry: handedOn(chainB, 0),
			sent: [chained(chainB, 0)],
			row: {
				id: 1,
				chain: chainB,
				link: 0,
				state: 'running',
				expiresAt: instant(2 * paceLeaseMs),
				nextAt: instant(paceLeaseMs + pace * 1000),
				updatedAt: instant(paceLeaseMs),
				lastOutcomes: '[]'
			}
		});
	});

	it('does not fork the chain when a message is delivered again', async () => {
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
					return Promise.reject(new Error('control database unavailable'));
				}

				return controlLocalStepWake(wakeLogger, wakeEnv, limit);
			}
		};

		const failed = await deliver(link(chainA, 0), options);
		// The queue's last redelivery starts after every earlier attempt has run
		// for as long as the consumer allows and waited out its retry delay. The
		// cron tick runs in the meantime.
		const lastRedelivery =
			pace * 1000 +
			maintenanceQueueMaxRetries *
				(queueConsumerWallClockMs + maintenanceQueueRetryDelaySeconds * 1000);
		vi.setSystemTime(new Date(start.getTime() + lastRedelivery));
		const tick = await restartLocalStepSweep(logger, env, options);
		const redelivered = await deliver(link(chainA, 0), options);
		const duplicate = await runLocalStepSweep(
			logger,
			env,
			{ chain: chainA, link: 0 },
			options
		);

		expect({
			failed,
			tick,
			redelivered,
			duplicate,
			sent,
			row: await sweepRow()
		}).toStrictEqual({
			failed: {
				action: 'retry',
				delaySeconds: maintenanceQueueRetryDelaySeconds,
				reason: 'Error: control database unavailable'
			},
			tick: { kind: 'held-elsewhere' },
			redelivered: { action: 'ack' },
			duplicate: { kind: 'superseded' },
			sent: [chained(chainA, 1)],
			row: {
				id: 1,
				chain: chainA,
				link: 1,
				state: 'running',
				expiresAt: instant(lastRedelivery + paceLeaseMs),
				nextAt: instant(lastRedelivery + pace * 1000),
				updatedAt: instant(lastRedelivery),
				lastOutcomes: JSON.stringify([recorded('again-a')])
			}
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
		const afterFirst = await readLocalStepSweep(database(), new Date());
		const second = await wakeLocalStepsAndContinue(logger, env, 1, options);

		expect({ first, afterFirst, second, sent }).toStrictEqual({
			first: {
				current: currentLocalStep,
				woken: 1,
				failed: 0,
				outcomes: [recorded('wake-a')]
			},
			// The wake's own batch is the chain's first.
			afterFirst: {
				state: 'running',
				chain: chainA,
				link: 0,
				updatedAt: instant(0),
				nextAt: instant(pace * 1000),
				outcomes: [recorded('wake-a')]
			},
			second: {
				current: currentLocalStep,
				woken: 1,
				failed: 0,
				outcomes: [recorded('wake-b')]
			},
			sent: [chained(chainA, 0)]
		});
	});

	it('backs off after a batch that advances nobody and records its outcomes', async () => {
		await provisionTenants(['stall-a', 'stall-b'], false);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			batchSize: 2,
			queue: sweepQueue(sent),
			newChain: () => chainB
		};
		const stalledOutcomes: LocalStepWakeOutcomes = [
			{ tenant: tenant('stall-a'), kind: 'unconfigured' },
			{ tenant: tenant('stall-b'), kind: 'unconfigured' }
		];

		const first = await runLocalStepSweep(
			logger,
			env,
			{ chain: chainA, link: 0 },
			options
		);
		const afterFirst = await readLocalStepSweep(database(), new Date());
		// Each delivery appends the chain's next message while this loops. The
		// chain keeps retrying at the cap, so stop once it has been reached twice.
		const delays = [first.kind === 'handed-on' ? first.delaySeconds : -1];
		for (const message of sent) {
			const continuation = await runLocalStepSweep(
				logger,
				env,
				message.body.chain,
				options
			);
			delays.push(
				continuation.kind === 'handed-on' ? continuation.delaySeconds : -1
			);

			if (
				delays.filter((delay) => delay === localStepSweepStallCapSeconds)
					.length === 2
			) {
				break;
			}
		}
		const last = sent.at(-1);

		expect({
			afterFirst,
			delays,
			sentDelays: sent.map((message) => message.delaySeconds),
			last,
			pending: await controlLocalStepPending(env),
			row: await sweepRow()
		}).toStrictEqual({
			afterFirst: {
				state: 'stalled',
				chain: chainA,
				link: 1,
				updatedAt: instant(0),
				nextAt: instant(pace * 1000),
				outcomes: stalledOutcomes
			},
			delays: [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600, 3600],
			sentDelays: [10, 20, 40, 80, 160, 320, 640, 1280, 2560, 3600, 3600],
			last: chained(chainA, 11, localStepSweepStallCapSeconds),
			pending: 2,
			row: {
				id: 1,
				chain: chainA,
				link: 11,
				state: 'stalled',
				expiresAt: instant(
					localStepSweepLeaseMs(localStepSweepStallCapSeconds)
				),
				nextAt: instant(localStepSweepStallCapSeconds * 1000),
				updatedAt: instant(0),
				lastOutcomes: JSON.stringify(stalledOutcomes)
			}
		});
	});

	it('resets the backoff when a batch makes progress', async () => {
		await provisionTenants(['reset-a'], false);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const failing = { tenant: tenant('reset-a'), kind: 'failed' as const };
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			wake: scriptedWake([
				stallBatch(failing),
				stallBatch(failing),
				progressBatch(recorded('reset-b')),
				stallBatch(failing),
				stallBatch(failing)
			])
		};

		// The links run one after another: each depends on the row the last wrote.
		const continuations: LocalStepSweepContinuation[] = [];
		for (const index of [0, 1, 2, 3, 4]) {
			const continuation = await runLocalStepSweep(
				logger,
				env,
				{ chain: chainA, link: index },
				options
			);
			continuations.push(continuation);
		}

		expect({
			continuations,
			sentDelays: sent.map((message) => message.delaySeconds)
		}).toStrictEqual({
			continuations: [
				handedOn(chainA, 1, 'stalled', 10),
				handedOn(chainA, 2, 'stalled', 20),
				handedOn(chainA, 3, 'running', 10),
				handedOn(chainA, 4, 'stalled', 10),
				handedOn(chainA, 5, 'stalled', 20)
			],
			sentDelays: [10, 20, 10, 10, 20]
		});
	});

	it('shows a dead chain as idle once its lease expires, and the cron tick restarts it', async () => {
		await provisionTenants(['dead-a']);
		await claimChain(chainA, [recorded('dead-b')]);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			newChain: () => chainB
		};

		const whileHeld = await controlLocalStepStatus(env);
		vi.setSystemTime(new Date(start.getTime() + paceLeaseMs));
		const expired = await controlLocalStepStatus(env);
		const restarted = await restartLocalStepSweep(logger, env, options);
		const afterRestart = await controlLocalStepStatus(env);

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
				nextAt: instant(pace * 1000),
				outcomes: [recorded('dead-b')]
			},
			expired: {
				state: 'idle',
				last: {
					chain: chainA,
					link: 0,
					updatedAt: instant(0),
					outcomes: [recorded('dead-b')]
				}
			},
			restarted: handedOn(chainB, 0),
			afterRestart: {
				state: 'running',
				chain: chainB,
				link: 0,
				updatedAt: instant(paceLeaseMs),
				nextAt: instant(paceLeaseMs + pace * 1000),
				outcomes: []
			},
			sent: [chained(chainB, 0)]
		});
	});

	it("reports the last batch's unconfigured and failed tenants in the status", async () => {
		await provisionTenants(['report-unconfigured'], false);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = {
			queue: sweepQueue(sent),
			wake: scriptedWake([
				stallBatch(
					{ tenant: tenant('report-unconfigured'), kind: 'unconfigured' },
					{ tenant: tenant('report-failed'), kind: 'failed' }
				)
			])
		};

		await runLocalStepSweep(logger, env, { chain: chainA, link: 0 }, options);

		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			required: currentLocalStep,
			ready: 0,
			pending: 1,
			stragglers: [tenant('report-unconfigured')],
			sweep: {
				state: 'stalled',
				chain: chainA,
				link: 1,
				updatedAt: instant(0),
				nextAt: instant(pace * 1000),
				outcomes: [
					{ tenant: tenant('report-unconfigured'), kind: 'unconfigured' },
					{ tenant: tenant('report-failed'), kind: 'failed' }
				]
			}
		});
	});

	it('ends the chain when a message cannot be sent', async () => {
		await provisionTenants(['unsent-a', 'unsent-b']);
		await claimChain(chainA);
		const options: LocalStepSweepOptions = {
			batchSize: 1,
			queue: {
				sendBatch: () => Promise.reject(new Error('queue unavailable'))
			}
		};

		await expect(
			runLocalStepSweep(logger, env, { chain: chainA, link: 0 }, options)
		).rejects.toThrow('queue unavailable');
		await expect(
			readLocalStepSweep(database(), new Date())
		).resolves.toStrictEqual({
			state: 'idle',
			last: {
				chain: chainA,
				link: 1,
				updatedAt: instant(0),
				outcomes: [recorded('unsent-a')]
			}
		});
	});
});

describe('local step sweep chain before the contraction', () => {
	// Before the cache-identity contraction an object reports at most step 4,
	// which is the step the transitions require then. Counting the tenants
	// against the build's final step would keep the chain running until the
	// contraction, which itself waits for the chain.
	it('ends once every tenant reaches the required step', async () => {
		await provisionTenants(['settle-a', 'settle-b']);
		await claimChain(chainA);
		const sent: SentSweep[] = [];
		const options: LocalStepSweepOptions = { queue: sweepQueue(sent) };

		const continuation = await runLocalStepSweep(
			logger,
			env,
			{ chain: chainA, link: 0 },
			options
		);

		expect({
			continuation,
			sent,
			status: await controlLocalStepStatus(env)
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
						outcomes: [
							recorded('settle-a', expansionLocalStep),
							recorded('settle-b', expansionLocalStep)
						]
					}
				}
			}
		});
	});
});
