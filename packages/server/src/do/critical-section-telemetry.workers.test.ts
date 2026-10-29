import { type Capture, startCapture } from '@cupboard/logger/testing';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';
import { withSpan } from '../observability/span.ts';
import { currentServer, initialise, resetTestServer } from '../test-support.ts';

import { observeCriticalSection } from './critical-section-telemetry.ts';
import {
	boundedSubrequest,
	currentDeadlineSignal,
	SectionSubrequests,
	withDeadlineBudget
} from './deadline.ts';
import { noCost } from './operation-cost.test-support.ts';
import {
	type OperationCostRecord,
	withOperationCost
} from './operation-cost.ts';

const overBudget = 'critical section over budget';

/**
Replaces each elapsed time in `value` with `measured`, because its value
depends on the scheduler.
*/
function withoutTimings(value: unknown): unknown {
	return JSON.parse(
		JSON.stringify(value, (key, field: unknown) =>
			key === 'elapsedMs' && typeof field === 'number' ? 'measured' : field
		)
	);
}

function parsedAttribute(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}

	const parsed: unknown = JSON.parse(value);

	return parsed;
}

function overBudgetRecords(capture: Capture): unknown {
	return withoutTimings(
		capture.logs
			.filter((log) => log.message === overBudget)
			.map(({ level, properties }) => ({ level, properties }))
	);
}

interface RecordedSpan {
	readonly name: string;
	readonly attributes: Record<string, unknown>;
	readonly set: [string, boolean | number | string][];
}

/**
Opens real spans and records the attributes that each one receives.
*/
function recordingSpans(): {
	readonly spans: RecordedSpan[];
	readonly withSpan: typeof withSpan;
} {
	const spans: RecordedSpan[] = [];

	return {
		spans,
		withSpan: (name, attributes, body) =>
			withSpan(name, attributes, (span) => {
				const recorded: RecordedSpan = { name, attributes, set: [] };
				spans.push(recorded);

				return body(
					new Proxy(span, {
						get: (target, property) => {
							if (property === 'setAttribute') {
								return (key: string, value: boolean | number | string) => {
									recorded.set.push([key, value]);

									return target.setAttribute(key, value);
								};
							}

							const member: unknown = Reflect.get(target, property);

							return typeof member === 'function'
								? (...parameters: unknown[]): unknown =>
										Reflect.apply(member, target, parameters)
								: member;
						}
					})
				);
			})
	};
}

function hangDeletes() {
	return vi
		.spyOn(env.BLOBS, 'delete')
		.mockImplementation(() => Promise.race([]));
}

describe('critical section telemetry', () => {
	let capture: Capture | undefined;
	let costs: OperationCostRecord[] = [];

	beforeEach(async () => {
		await resetTestServer();
		costs = [];
	});
	afterEach(() => {
		capture?.stop();
		capture = undefined;
	});

	it('records a section that passes its budget with its label and pending subrequests', async () => {
		await initialise();
		const server = currentServer();
		await runInDurableObject(server, (instance) => {
			instance.context.gateBudgetMs = 100;
		});
		const hang = hangDeletes();
		const logs = startCapture();
		capture = logs;

		let rejection: unknown;
		try {
			await runInDurableObject(server, (instance) =>
				withOperationCost(
					'gated-delete',
					() =>
						instance.context.criticalSection(() =>
							instance.context.env.BLOBS.delete('gated-key')
						),
					(cost) => {
						costs.push(cost);
					}
				)
			);
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
			await runInDurableObject(server, (instance) => {
				instance.context.gateBudgetMs = 25_000;
			});
		}

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			records: overBudgetRecords(logs),
			costs
		}).toStrictEqual({
			timedOut: true,
			records: [
				{
					level: 'warning',
					properties: {
						label: 'gated-delete',
						budgetMs: 100,
						elapsedMs: 'measured',
						pendingSubrequests: [
							{ operation: 'r2.delete', elapsedMs: 'measured' }
						]
					}
				}
			],
			costs: [{ ...noCost, r2Delete: 1 }]
		});
	});

	// An enclosing deadline that ends first aborts the section before its own
	// budget, so the section did not pass its budget. The test runs the
	// observer outside a gate. On the test pool's workerd (1.20260815.1), a
	// due timer that was created outside a gate keeps the gate's own timers
	// from firing, so the object resets after 30 seconds. workerd fixed this
	// in v1.20261014.1 (commit 1fa562228).
	it('writes no record when an enclosing deadline stops the section', async () => {
		const hang = hangDeletes();
		const logs = startCapture();
		capture = logs;

		let rejection: unknown;
		try {
			await withDeadlineBudget(50, () =>
				observeCriticalSection(
					() =>
						boundedSubrequest(() => env.BLOBS.delete('gated-key'), 'r2.delete'),
					{ budgetMs: 100, withSpan: undefined }
				)
			);
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
		}

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			records: overBudgetRecords(logs)
		}).toStrictEqual({ timedOut: true, records: [] });
	});

	it('records the budget, elapsed time and pending subrequests in the span', async () => {
		const recorder = recordingSpans();
		const hang = hangDeletes();
		const logs = startCapture();
		capture = logs;

		let rejection: unknown;
		try {
			await withOperationCost(
				'gated-delete',
				() =>
					observeCriticalSection(
						() =>
							boundedSubrequest(
								() => env.BLOBS.delete('gated-key'),
								'r2.delete'
							),
						{ budgetMs: 100, withSpan: recorder.withSpan }
					),
				(cost) => {
					costs.push(cost);
				}
			);
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
		}

		const [span] = recorder.spans;
		const pending = span?.set.find(([key]) => key === 'pendingSubrequests');
		const set = Object.fromEntries(
			span?.set.filter(([key]) => key !== 'pendingSubrequests') ?? []
		);

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			span: withoutTimings({
				name: span?.name,
				attributes: span?.attributes,
				set,
				pendingSubrequests: parsedAttribute(pending?.[1])
			}),
			records: logs.logs.filter((log) => log.message === overBudget).length
		}).toStrictEqual({
			timedOut: true,
			span: {
				name: 'critical-section',
				attributes: { label: 'gated-delete' },
				set: { overBudget: true, budgetMs: 100, elapsedMs: 'measured' },
				pendingSubrequests: [{ operation: 'r2.delete', elapsedMs: 'measured' }]
			},
			records: 1
		});
	});

	it('writes no record for a section that finishes within its budget', async () => {
		await initialise();
		const logs = startCapture();
		capture = logs;

		const value = await runInDurableObject(currentServer(), (instance) =>
			withOperationCost(
				'quick-section',
				() => instance.context.criticalSection(() => Promise.resolve('ok')),
				(cost) => {
					costs.push(cost);
				}
			)
		);

		expect({
			value,
			records: overBudgetRecords(logs),
			costs
		}).toStrictEqual({
			value: 'ok',
			records: [],
			costs: [noCost]
		});
	});

	// The section's deadline timer and a subrequest's timer are due at the same
	// instant. When the subrequest's timer fires first, the subrequest reports
	// the deadline to the section. This test watches the deadline without an
	// abort listener, so only that report can call the callback.
	it('reports a subrequest that times out at the watched deadline', async () => {
		const sections = new SectionSubrequests();
		const hang = hangDeletes();
		let reports = 0;
		let reportsAfterUnwatch = 0;
		let rejection: unknown;

		try {
			await withDeadlineBudget(50, () =>
				sections.run(async () => {
					const deadline = currentDeadlineSignal();

					if (deadline === undefined) {
						throw new Error('The deadline scope has no signal.');
					}

					sections.watchDeadline(deadline, () => {
						reports += 1;
					});

					try {
						await boundedSubrequest(
							() => env.BLOBS.delete('gated-key'),
							'r2.delete'
						);
					} finally {
						sections.unwatchDeadline();
						sections.timedOutAt(deadline);
						reportsAfterUnwatch = reports;
					}
				})
			);
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
		}

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			reports,
			reportsAfterUnwatch
		}).toStrictEqual({ timedOut: true, reports: 1, reportsAfterUnwatch: 1 });
	});
});
