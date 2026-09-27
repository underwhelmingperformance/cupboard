import {
	cacheGenerationSchema,
	cacheNameSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	localStepStallWindowMs
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import {
	asOneInvocation,
	bootstrap,
	currentServer,
	migrateThrough,
	recordTransition,
	takeStalledMaintenancePasses,
	testBase,
	testServerFor,
	useTestServer
} from '../test-support.ts';

import { noProgressRetryMs } from './alarm.ts';
import { maxCachesProjectedPerRun } from './cache-lifecycle-projection.ts';
import {
	type LocalStepOutcome,
	localStepPendingKey,
	localStepStalledSinceKey,
	repeatedRecordingKey
} from './local-step.ts';
import {
	localStepGaveUpError,
	localStepProgressWriteIntervalMs,
	LocalStepRun
} from './local-step-run.ts';
import { CupboardServer } from './server.ts';

const start = testBase.getTime();

class InjectedPageFault extends Error {
	constructor() {
		super();
		this.name = 'InjectedPageFault';
	}
}

/**
 * An object's alarm, replaced by a recorder. The platform never delivers it,
 * so the test delivers each alarm itself.
 */
interface RecordedAlarm {
	/**
	 * Every time that the object armed, in order.
	 */
	readonly armed: readonly number[];
	/**
	 * Clears the armed time and runs the alarm handler, as the platform does.
	 */
	deliver(): Promise<void>;
	/**
	 * Delivers the alarm to a new instance over the same storage, as the
	 * platform does after it evicts or resets the object.
	 */
	deliverAfterRestart(): Promise<void>;
	/**
	 * Makes the object's attempts to arm the alarm for `time` throw, as they
	 * would if the object were reset at that point. `undefined` stops it.
	 */
	refuseArmingAt(time: number | undefined): void;
}

class InjectedResetFault extends Error {
	constructor() {
		super();
		this.name = 'InjectedResetFault';
	}
}

async function withRecordedAlarm<T>(
	body: (alarm: RecordedAlarm) => Promise<T>,
	server: DurableObjectStub<CupboardServer> = currentServer()
): Promise<T> {
	const armed: number[] = [];
	// An alarm armed for `Infinity` is later than any time that the object asks
	// for, so it reads as no alarm.
	let scheduled = Infinity;
	let refused: number | undefined;
	const restorers: (() => void)[] = [];

	await runInDurableObject(server, (_instance, state) => {
		const getAlarm = vi
			.spyOn(state.storage, 'getAlarm')
			.mockImplementation(() => Promise.resolve(scheduled));
		const setAlarm = vi
			.spyOn(state.storage, 'setAlarm')
			.mockImplementation((scheduledTime) => {
				const time = new Date(scheduledTime).getTime();

				if (time === refused) {
					return Promise.reject(new InjectedResetFault());
				}

				scheduled = time;
				armed.push(time);

				return Promise.resolve();
			});

		restorers.push(
			() => {
				getAlarm.mockRestore();
			},
			() => {
				setAlarm.mockRestore();
			}
		);
	});

	try {
		return await body({
			armed,
			deliver: async () => {
				scheduled = Infinity;
				await runInDurableObject(server, (instance) => instance.alarm());
			},
			refuseArmingAt: (time) => {
				refused = time;
			},
			deliverAfterRestart: async () => {
				scheduled = Infinity;
				await runInDurableObject(server, (instance, state) =>
					new CupboardServer(state, instance.context.env).alarm()
				);
			}
		});
	} finally {
		for (const restore of restorers) {
			restore();
		}
	}
}

function wake(
	required: LocalStep = expansionLocalStep,
	server: DurableObjectStub<CupboardServer> = currentServer()
): Promise<LocalStepOutcome> {
	return runInDurableObject(server, (instance) =>
		instance.reportLocalStep(required)
	);
}

function readPending(
	server: DurableObjectStub<CupboardServer> = currentServer()
): Promise<boolean> {
	return runInDurableObject(
		server,
		async (_instance, state) =>
			(await state.storage.get(localStepPendingKey)) !== undefined
	);
}

// Delivers alarms until the object has no local-step work pending, at most
// `limit` times, and returns how many it delivered.
async function deliverWhilePending(
	alarm: RecordedAlarm,
	limit: number
): Promise<number> {
	let delivered = 0;

	while (delivered < limit && (await readPending())) {
		await alarm.deliver();
		delivered += 1;
	}

	return delivered;
}

// The tenant row's local-step columns. An empty column reads as undefined.
async function localStepRow(
	server: DurableObjectStub<CupboardServer> = currentServer()
) {
	const tenant = await runInDurableObject(server, (instance) =>
		instance.context.requireTenant()
	);
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({
			localStep: d1Schema.tenant.localStep,
			attemptedAt: d1Schema.tenant.localStepAttemptedAt,
			progressedAt: d1Schema.tenant.localStepProgressedAt,
			error: d1Schema.tenant.localStepError
		})
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenant))
		.get();

	return {
		localStep: row?.localStep ?? undefined,
		attemptedAt: row?.attemptedAt ?? undefined,
		progressedAt: row?.progressedAt ?? undefined,
		error: row?.error ?? undefined
	};
}

async function useServerWithCaches(name: string, count: number) {
	await useTestServer(name);
	await bootstrap({
		caches: Array.from({ length: count }, (_, index) => ({
			scope: {
				kind: 'named' as const,
				name: cacheNameSchema.parse(`cache-${String(index).padStart(3, '0')}`)
			}
		}))
	});
}

// Every page from here on fails when it lists the legacy object prefixes.
function failEveryPage(): Promise<void> {
	return runInDurableObject(currentServer(), (instance) => {
		const blobs = instance.context.env.BLOBS;

		instance.context.env = {
			...instance.context.env,
			BLOBS: {
				...blobs,
				head: blobs.head.bind(blobs),
				get: blobs.get.bind(blobs),
				put: blobs.put.bind(blobs),
				delete: blobs.delete.bind(blobs),
				list: () => Promise.reject(new InjectedPageFault()),
				createMultipartUpload: blobs.createMultipartUpload.bind(blobs),
				resumeMultipartUpload: blobs.resumeMultipartUpload.bind(blobs)
			}
		};
	});
}

// The name of the error that `promise` rejects with, or undefined when it
// resolves.
async function rejectionName(
	promise: Promise<unknown>
): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.name : String(error);
	}

	return undefined;
}

function at(ms: number): string {
	return new Date(ms).toISOString();
}

describe('local-step work on the alarm', () => {
	it('records the step of a tenant with more caches than one page after one wake', async () => {
		await useServerWithCaches('local-step-alarm', maxCachesProjectedPerRun + 5);

		const value = await withRecordedAlarm(async (alarm) => ({
			wake: await wake(),
			alarms: await deliverWhilePending(alarm, 20),
			armed: alarm.armed
		}));

		expect({
			...value,
			pending: await readPending(),
			row: await localStepRow()
		}).toStrictEqual({
			wake: { kind: 'incomplete', projected: 0, progressed: true },
			alarms: 3,
			// The wake arms a retry before its page runs. Then the wake and each
			// alarm that left work arm the next alarm at once.
			armed: [start + noProgressRetryMs, start, start, start],
			pending: false,
			// Recording the step clears the attempt time.
			row: {
				localStep: expansionLocalStep,
				attemptedAt: undefined,
				progressedAt: at(start),
				error: undefined
			}
		});
	});

	it('writes progress at most once per interval', async () => {
		await useServerWithCaches(
			'local-step-throttle',
			maxCachesProjectedPerRun * 3 + 5
		);

		const rows = await withRecordedAlarm(async (alarm) => {
			await wake();
			vi.setSystemTime(start + localStepProgressWriteIntervalMs - 1);
			await alarm.deliver();
			const throttled = await localStepRow();
			vi.setSystemTime(start + localStepProgressWriteIntervalMs);
			await alarm.deliver();

			return { throttled, written: await localStepRow() };
		});

		const later = at(start + localStepProgressWriteIntervalMs);

		expect(rows).toStrictEqual({
			throttled: {
				localStep: undefined,
				attemptedAt: at(start),
				progressedAt: at(start),
				error: undefined
			},
			written: {
				localStep: undefined,
				attemptedAt: later,
				progressedAt: later,
				error: undefined
			}
		});
	});

	it('retries a failing page after the retry delay and gives up after the stall window', async () => {
		await useServerWithCaches('local-step-failing', 0);
		await failEveryPage();

		const retries = localStepStallWindowMs / noProgressRetryMs;
		const value = await withRecordedAlarm(async (alarm) => {
			const first = await wake();
			let alarms = 0;

			while (alarms <= retries && (await readPending())) {
				vi.setSystemTime(start + (alarms + 1) * noProgressRetryMs);
				await alarm.deliver();
				alarms += 1;
			}

			return { first, alarms, armed: alarm.armed, row: await localStepRow() };
		});

		expect({
			...value,
			stalled: await takeStalledMaintenancePasses()
		}).toStrictEqual({
			first: { kind: 'failed', error: 'InjectedPageFault' },
			alarms: retries,
			row: {
				localStep: undefined,
				attemptedAt: at(start + localStepStallWindowMs),
				progressedAt: undefined,
				error: 'InjectedPageFault'
			},
			// The wake and every retry but the last arm the next retry.
			armed: Array.from(
				{ length: retries },
				(_, index) => start + (index + 1) * noProgressRetryMs
			),
			stalled: []
		});
	});

	it('does not count a recording of the step that the tenant already had as progress', async () => {
		await useServerWithCaches('local-step-repeat', 1);

		const outcomes = await withRecordedAlarm(async () => {
			const first = await wake();
			vi.setSystemTime(start + 1000);
			const second = await wake();

			return { first, second };
		});

		expect({ ...outcomes, row: await localStepRow() }).toStrictEqual({
			first: { kind: 'recorded', step: expansionLocalStep, progressed: true },
			second: { kind: 'recorded', step: expansionLocalStep, progressed: false },
			row: {
				localStep: expansionLocalStep,
				attemptedAt: undefined,
				progressedAt: at(start),
				error: undefined
			}
		});
	});

	it('finishes the same work when a wake arrives twice at once', async () => {
		await useServerWithCaches(
			'local-step-duplicate',
			maxCachesProjectedPerRun + 5
		);

		const value = await withRecordedAlarm(async (alarm) => ({
			wakes: await Promise.all([wake(), wake()]),
			alarms: await deliverWhilePending(alarm, 20)
		}));

		expect({
			...value,
			pending: await readPending(),
			row: await localStepRow()
		}).toStrictEqual({
			wakes: [
				{ kind: 'incomplete', projected: 0, progressed: true },
				{ kind: 'incomplete', projected: 0, progressed: true }
			],
			alarms: 2,
			pending: false,
			// Recording the step clears the attempt time.
			row: {
				localStep: expansionLocalStep,
				attemptedAt: undefined,
				progressedAt: at(start),
				error: undefined
			}
		});
	});

	// The alarm's last page records the step while a second wake for the same
	// step arrives. The wake must not start the work again after the page has
	// finished it, or the idle object would read as working.
	it('lets a wake that overlaps the page that records the step leave no work behind', async () => {
		await useServerWithCaches(
			'local-step-overlap',
			maxCachesProjectedPerRun + 5
		);

		const value = await withRecordedAlarm(async (alarm) => {
			await wake();
			await alarm.deliver();
			await alarm.deliver();
			const [, duplicate] = await Promise.all([alarm.deliver(), wake()]);

			return {
				duplicate: duplicate.kind,
				alarms: await deliverWhilePending(alarm, 20)
			};
		});

		expect({
			...value,
			pending: await readPending(),
			row: await localStepRow()
		}).toStrictEqual({
			duplicate: 'recorded',
			alarms: 0,
			pending: false,
			row: {
				localStep: expansionLocalStep,
				attemptedAt: undefined,
				progressedAt: at(start),
				error: undefined
			}
		});
	});

	// A page that recorded step 4 again leaves the flag that stops restarted
	// cursors from counting as progress. Once step 5 is requested, the pages
	// work towards a step that the tenant has not reached, so each cursor that
	// advances is progress, and the object must not give up while it walks
	// through a large tenant's caches.
	it(
		'keeps working towards a higher step after a repeated recording while its cursors advance',
		{ timeout: 120_000 },
		async () => {
			await useServerWithCaches('local-step-higher', 1000);
			await runInDurableObject(currentServer(), async (instance, state) => {
				await state.storage.put(repeatedRecordingKey, expansionLocalStep);
				await instance.context.d1
					.update(d1Schema.tenant)
					.set({ localStep: expansionLocalStep })
					.where(eq(d1Schema.tenant.id, instance.context.requireTenant()))
					.run();
			});
			await recordTransition('cache-identity', 'complete');

			const value = await withRecordedAlarm(async (alarm) => {
				const first = await wake(currentLocalStep);
				let alarms = 0;

				// Each alarm arrives thirty seconds after the previous one, as it would
				// if every page stalled.
				while (alarms < 200 && (await readPending())) {
					alarms += 1;
					vi.setSystemTime(start + alarms * noProgressRetryMs);
					await alarm.deliver();
				}

				return { first, alarms };
			});
			const finishedAt = start + value.alarms * noProgressRetryMs;

			expect({
				first: value.first,
				outlastsStallWindow: finishedAt - start > localStepStallWindowMs,
				pending: await readPending(),
				row: await localStepRow()
			}).toStrictEqual({
				first: { kind: 'incomplete', projected: 0, progressed: true },
				outlastsStallWindow: true,
				pending: false,
				row: {
					localStep: currentLocalStep,
					attemptedAt: undefined,
					progressedAt: at(finishedAt),
					error: undefined
				}
			});
		}
	);

	// The object stores the request as soon as its migrations have started,
	// and the alarm continues them. A restart in between keeps the request, so
	// the new instance finishes the work without another wake.
	it('finishes the work when the object restarts during its pending migrations', async () => {
		const tenant = tenantIdSchema.parse('local-step-restart');
		const createdAt = isoTimestamp(testBase);
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.insert(d1Schema.tenant)
			.values({
				id: tenant,
				status: 'active',
				ownerIssuer: 'https://idp.test',
				ownerSubject: 'owner',
				ownerAudience: 'cupboard',
				configVersion: 1,
				createdAt
			});
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.insert(d1Schema.cacheLifecycle)
			.values({
				tenant,
				cacheKind: 'default',
				cacheName: sql`null`,
				access: 'public',
				generation: cacheGenerationSchema.parse(1),
				updatedAt: createdAt
			});
		const server = testServerFor(tenant);
		await runInDurableObject(server, async (_instance, state) => {
			await migrateThrough(state, 41);
			state.storage.sql.exec(
				"INSERT INTO tenant_identity (id, tenant, issuer, audience, owner_issuer, owner_subject, owner_audience, config_version) VALUES ('singleton', ?, 'https://idp.test', 'cupboard', 'https://idp.test', 'owner', 'cupboard', 1)",
				tenant
			);
			for (let index = 0; index < 80; index++) {
				state.storage.sql.exec(
					'INSERT INTO cache (name, priority, created_at) VALUES (?, 40, ?)',
					`cache-${String(index).padStart(3, '0')}`,
					createdAt
				);
			}
		});

		const value = await withRecordedAlarm(async (alarm) => {
			const first = await wake(expansionLocalStep, server);
			let alarms = 0;

			// The first alarm continues the pending migrations, and the object writes
			// that progress.
			vi.setSystemTime(start + 1000);
			await alarm.deliverAfterRestart();
			const afterMigrationAlarm = await localStepRow(server);

			while (alarms < 200 && (await readPending(server))) {
				alarms += 1;
				await alarm.deliverAfterRestart();
			}

			return { first, afterMigrationAlarm, finished: alarms < 200 };
		}, server);

		const row = await localStepRow(server);

		expect({
			...value,
			pending: await readPending(server),
			localStep: row.localStep
		}).toStrictEqual({
			first: { kind: 'incomplete', projected: 0, progressed: true },
			afterMigrationAlarm: {
				localStep: undefined,
				attemptedAt: at(start + 1000),
				progressedAt: at(start + 1000),
				error: undefined
			},
			finished: true,
			pending: false,
			localStep: expansionLocalStep
		});
		await runInDurableObject(server, (_instance, state) =>
			state.storage.deleteAlarm()
		);
	});

	it('continues on the alarm when a wake stops before it arms the next page', async () => {
		await useServerWithCaches('local-step-reset', maxCachesProjectedPerRun + 5);

		const value = await withRecordedAlarm(async (alarm) => {
			alarm.refuseArmingAt(start);
			const rejection = await rejectionName(wake());
			alarm.refuseArmingAt(undefined);
			const armedByWake = [...alarm.armed];
			vi.setSystemTime(start + noProgressRetryMs);

			return {
				rejection,
				armedByWake,
				alarms: await deliverWhilePending(alarm, 20)
			};
		});

		const row = await localStepRow();

		expect({
			...value,
			pending: await readPending(),
			localStep: row.localStep
		}).toStrictEqual({
			rejection: 'InjectedResetFault',
			armedByWake: [start + noProgressRetryMs],
			alarms: 3,
			pending: false,
			localStep: expansionLocalStep
		});
	});

	// Every wake gives the object a new stall window, so a repair followed by a
	// wake is retried for the whole window.
	it('starts the stall window again on each wake', async () => {
		await useServerWithCaches('local-step-rewake', 0);
		await failEveryPage();
		const rewakeAt = start + 5 * 60 * 1000;

		const value = await withRecordedAlarm(async (alarm) => {
			await wake();
			let alarms = 0;

			while (alarms <= 100 && (await readPending())) {
				alarms += 1;
				const now = start + alarms * noProgressRetryMs;
				vi.setSystemTime(now);

				if (now === rewakeAt) {
					await wake();
					continue;
				}

				await alarm.deliver();
			}

			return { row: await localStepRow() };
		});

		expect({
			...value,
			stalled: await takeStalledMaintenancePasses()
		}).toStrictEqual({
			row: {
				localStep: undefined,
				attemptedAt: at(rewakeAt + localStepStallWindowMs),
				progressedAt: undefined,
				error: 'InjectedPageFault'
			},
			stalled: []
		});
	});

	it('records why it stopped when it gives up after pages that did not fail', async () => {
		await useServerWithCaches('local-step-give-up', 0);

		const continuation = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const run = new LocalStepRun(instance.context);
				const outcome: LocalStepOutcome = {
					kind: 'incomplete',
					projected: 0,
					progressed: false
				};
				const now = start + localStepStallWindowMs;

				await run.request(expansionLocalStep);
				await state.storage.put(localStepStalledSinceKey, start);
				const settled = await run.settle(outcome, now);
				await asOneInvocation(() => run.recordAttempt(outcome, now, settled));

				return settled;
			}
		);

		expect({
			continuation,
			pending: await readPending(),
			row: await localStepRow()
		}).toStrictEqual({
			continuation: 'given-up',
			pending: false,
			row: {
				localStep: undefined,
				attemptedAt: at(start + localStepStallWindowMs),
				progressedAt: undefined,
				error: localStepGaveUpError
			}
		});
	});

	// Until the deploy records `cache-identity` complete, a page records at most
	// step 4. A wake for step 5 then leaves the object working, so the row keeps
	// the attempt.
	it('keeps the attempt time when a page records a step below the requested one', async () => {
		await useServerWithCaches('local-step-below', 1);

		const outcome = await withRecordedAlarm(() => wake(currentLocalStep));

		expect({
			outcome,
			pending: await readPending(),
			row: await localStepRow()
		}).toStrictEqual({
			outcome: { kind: 'recorded', step: expansionLocalStep, progressed: true },
			pending: true,
			row: {
				localStep: expansionLocalStep,
				attemptedAt: at(start),
				progressedAt: at(start),
				error: undefined
			}
		});
	});
});
