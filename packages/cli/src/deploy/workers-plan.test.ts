import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

import type { AccountSubscriptions } from './cloudflare-api.ts';
import {
	establishWorkersPlan,
	invocationAllowanceFor,
	workersPlanFrom
} from './workers-plan.ts';

function listed(
	...subscriptions: readonly {
		readonly state: string;
		readonly ratePlanId: string;
	}[]
): AccountSubscriptions {
	return { kind: 'listed', subscriptions };
}

describe('workersPlanFrom', () => {
	it.each([
		{
			name: 'an account on Workers Paid',
			subscriptions: listed({ state: 'Paid', ratePlanId: 'workers_paid' }),
			plan: { kind: 'paid', ratePlanId: 'workers_paid' },
			subrequests: workersInvocationAllowances.paid.subrequests
		},
		{
			name: 'an unverified enterprise rate-plan identifier',
			subscriptions: listed({
				state: 'Provisioned',
				ratePlanId: 'workers_ent_contract'
			}),
			plan: {
				kind: 'unknown',
				cause: 'unrecognised-rate-plan',
				ratePlanId: 'workers_ent_contract'
			},
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'a rate plan id in upper case',
			subscriptions: listed({ state: 'Paid', ratePlanId: 'WORKERS_PAID' }),
			plan: { kind: 'paid', ratePlanId: 'workers_paid' },
			subrequests: workersInvocationAllowances.paid.subrequests
		},
		{
			name: 'an explicit Workers Free subscription',
			subscriptions: listed({
				state: 'Provisioned',
				ratePlanId: 'workers_free'
			}),
			plan: { kind: 'free' },
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'an account with no Workers subscription at all',
			subscriptions: listed({ state: 'Paid', ratePlanId: 'pro' }),
			plan: { kind: 'free' },
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'a cancelled paid subscription',
			subscriptions: listed({
				state: 'Cancelled',
				ratePlanId: 'workers_paid'
			}),
			plan: { kind: 'free' },
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'a token that cannot read the subscriptions',
			subscriptions: { kind: 'unreadable' } as const,
			plan: { kind: 'unknown', cause: 'subscriptions-unreadable' },
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'an endpoint that did not answer',
			subscriptions: { kind: 'unavailable' } as const,
			plan: { kind: 'unknown', cause: 'subscriptions-unavailable' },
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'a response this build cannot read',
			subscriptions: { kind: 'unparsed' } as const,
			plan: { kind: 'unknown', cause: 'subscriptions-unparsed' },
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'a Workers subscription on a rate plan this build does not know',
			subscriptions: listed({
				state: 'Paid',
				ratePlanId: 'workers_for_platforms_ent'
			}),
			plan: {
				kind: 'unknown',
				cause: 'unrecognised-rate-plan',
				ratePlanId: 'workers_for_platforms_ent'
			},
			subrequests: workersInvocationAllowances.free.subrequests
		}
	])('reads $name', ({ subscriptions, plan, subrequests }) => {
		const read = workersPlanFrom(subscriptions);

		expect({
			plan: read,
			subrequests: invocationAllowanceFor(read).subrequests
		}).toStrictEqual({
			plan,
			subrequests
		});
	});

	it('prefers a paid subscription to an unrecognised one', () => {
		const read = workersPlanFrom(
			listed(
				{ state: 'Paid', ratePlanId: 'workers_for_platforms_ent' },
				{ state: 'Paid', ratePlanId: 'workers_paid' }
			)
		);

		expect(read).toStrictEqual({ kind: 'paid', ratePlanId: 'workers_paid' });
	});
});

function recordingUi(): {
	readonly ui: {
		info: (message: string) => void;
		warn: (message: string) => void;
	};
	readonly reported: { level: 'info' | 'warn'; message: string }[];
} {
	const reported: { level: 'info' | 'warn'; message: string }[] = [];

	return {
		reported,
		ui: {
			info: (message) => {
				reported.push({ level: 'info', message });
			},
			warn: (message) => {
				reported.push({ level: 'warn', message });
			}
		}
	};
}

const unreadable: AccountSubscriptions = { kind: 'unreadable' };
const unavailable: AccountSubscriptions = { kind: 'unavailable' };
const unparsed: AccountSubscriptions = { kind: 'unparsed' };
const unrecognisedRatePlan = listed({
	state: 'Paid',
	ratePlanId: 'workers_for_platforms_ent'
});

const unknownSubscriptions: readonly AccountSubscriptions[] = [
	unreadable,
	unavailable,
	unparsed,
	unrecognisedRatePlan
];

describe('establishWorkersPlan', () => {
	it.each([
		{
			name: 'a paid account',
			message:
				'Detected Workers Paid (workers_paid); using 10000 subrequests per invocation.',
			subscriptions: listed({ state: 'Paid', ratePlanId: 'workers_paid' }),
			level: 'info' as const,
			subrequests: workersInvocationAllowances.paid.subrequests
		},
		{
			name: 'a free account',
			message:
				'No active paid Workers subscription was recognised; using 1000 subrequests per invocation.',
			subscriptions: listed({ state: 'Paid', ratePlanId: 'workers_free' }),
			level: 'info' as const,
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'a token that cannot read the subscriptions',
			message:
				"The deployment token cannot read the account's subscriptions. Using the Workers Free allowance (1000 subrequests per invocation). If this account is on Workers Paid, pass `--workers-plan paid`.",
			subscriptions: unreadable,
			level: 'warn' as const,
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'an endpoint that did not answer',
			message:
				"Could not retrieve the account's subscriptions from Cloudflare. Using the Workers Free allowance (1000 subrequests per invocation). If this account is on Workers Paid, pass `--workers-plan paid`.",
			subscriptions: unavailable,
			level: 'warn' as const,
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'a response this build cannot read',
			message:
				'Cloudflare returned account subscriptions this build cannot read. Using the Workers Free allowance (1000 subrequests per invocation). If this account is on Workers Paid, pass `--workers-plan paid`.',
			subscriptions: unparsed,
			level: 'warn' as const,
			subrequests: workersInvocationAllowances.free.subrequests
		},
		{
			name: 'a rate plan this build does not know',
			message:
				'Unrecognised Workers rate plan: workers_for_platforms_ent. Using the Workers Free allowance (1000 subrequests per invocation). If this account is on Workers Paid, pass `--workers-plan paid`.',
			subscriptions: unrecognisedRatePlan,
			level: 'warn' as const,
			subrequests: workersInvocationAllowances.free.subrequests
		}
	])(
		'sizes the allowance from $name and reports it once',
		async ({ subscriptions, level, subrequests, message }) => {
			const { ui, reported } = recordingUi();
			const established = await establishWorkersPlan({
				ui,
				api: { listAccountSubscriptions: () => Promise.resolve(subscriptions) }
			});

			expect({
				subrequests: established.subrequests,
				reported
			}).toStrictEqual({ subrequests, reported: [{ level, message }] });
		}
	);

	it('tells every unknown outcome apart in what it reports', async () => {
		const messages = await Promise.all(
			unknownSubscriptions.map(async (subscriptions) => {
				const { ui, reported } = recordingUi();
				await establishWorkersPlan({
					ui,
					api: {
						listAccountSubscriptions: () => Promise.resolve(subscriptions)
					}
				});

				return reported.map((report) => report.message).join('\n');
			})
		);

		expect(new Set(messages).size).toBe(unknownSubscriptions.length);
	});

	it('passes the run signal to the subscriptions request', async () => {
		const { ui } = recordingUi();
		const cancelled = new AbortController();
		const seen: (AbortSignal | undefined)[] = [];
		await establishWorkersPlan({
			ui,
			signal: cancelled.signal,
			api: {
				listAccountSubscriptions: (signal) => {
					seen.push(signal);

					return Promise.resolve(unreadable);
				}
			}
		});

		expect(seen).toStrictEqual([cancelled.signal]);
	});

	it('uses the explicit plan without reading subscriptions', async () => {
		const { ui, reported } = recordingUi();
		let listings = 0;
		const established = await establishWorkersPlan({
			ui,
			override: 'paid',
			api: {
				listAccountSubscriptions: () => {
					listings += 1;

					return Promise.resolve(unreadable);
				}
			}
		});

		expect({
			subrequests: established.subrequests,
			listings,
			reported,
			source: established.source
		}).toStrictEqual({
			source: { kind: 'override', plan: 'paid' },
			subrequests: workersInvocationAllowances.paid.subrequests,
			listings: 0,
			reported: [
				{
					level: 'info',
					message:
						'Using 10000 subrequests per invocation for Workers paid (`--workers-plan`).'
				}
			]
		});
	});
});
