import {
	freeTierD1StatementsPerInvocation,
	paidTierD1StatementsPerInvocation
} from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

import type { AccountSubscriptions } from './cloudflare-api.ts';
import {
	d1StatementsFor,
	establishWorkersPlan,
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
			statements: paidTierD1StatementsPerInvocation
		},
		{
			// An exact test against `workers_paid` would call this account free and
			// budget it at a twentieth of what it may run.
			name: 'an enterprise account, which is also paid',
			subscriptions: listed({
				state: 'Provisioned',
				ratePlanId: 'workers_ent_contract'
			}),
			plan: { kind: 'paid', ratePlanId: 'workers_ent_contract' },
			statements: paidTierD1StatementsPerInvocation
		},
		{
			name: 'a rate plan id in upper case',
			subscriptions: listed({ state: 'Paid', ratePlanId: 'WORKERS_PAID' }),
			plan: { kind: 'paid', ratePlanId: 'workers_paid' },
			statements: paidTierD1StatementsPerInvocation
		},
		{
			name: 'an account that positively reports Workers Free',
			subscriptions: listed({
				state: 'Provisioned',
				ratePlanId: 'workers_free'
			}),
			plan: { kind: 'free' },
			statements: freeTierD1StatementsPerInvocation
		},
		{
			name: 'an account with no Workers subscription at all',
			subscriptions: listed({ state: 'Paid', ratePlanId: 'pro' }),
			plan: { kind: 'free' },
			statements: freeTierD1StatementsPerInvocation
		},
		{
			// The paid subscription has lapsed, so its rate plan says nothing about
			// what the account may run today.
			name: 'a cancelled paid subscription',
			subscriptions: listed({
				state: 'Cancelled',
				ratePlanId: 'workers_paid'
			}),
			plan: { kind: 'free' },
			statements: freeTierD1StatementsPerInvocation
		},
		{
			name: 'a token that cannot read the subscriptions',
			subscriptions: { kind: 'unreadable' } as const,
			plan: { kind: 'unknown', cause: 'subscriptions-unreadable' },
			statements: freeTierD1StatementsPerInvocation
		},
		{
			name: 'an endpoint that did not answer',
			subscriptions: { kind: 'unavailable' } as const,
			plan: { kind: 'unknown', cause: 'subscriptions-unavailable' },
			statements: freeTierD1StatementsPerInvocation
		},
		{
			name: 'a response this build cannot read',
			subscriptions: { kind: 'unparsed' } as const,
			plan: { kind: 'unknown', cause: 'subscriptions-unparsed' },
			statements: freeTierD1StatementsPerInvocation
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
			statements: freeTierD1StatementsPerInvocation
		}
	])('reads $name', ({ subscriptions, plan, statements }) => {
		const read = workersPlanFrom(subscriptions);

		expect({ plan: read, statements: d1StatementsFor(read) }).toStrictEqual({
			plan,
			statements
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
			subscriptions: listed({ state: 'Paid', ratePlanId: 'workers_paid' }),
			level: 'info' as const,
			statements: paidTierD1StatementsPerInvocation
		},
		{
			name: 'a free account',
			subscriptions: listed({ state: 'Paid', ratePlanId: 'workers_free' }),
			level: 'info' as const,
			statements: freeTierD1StatementsPerInvocation
		},
		{
			name: 'a token that cannot read the subscriptions',
			subscriptions: unreadable,
			level: 'warn' as const,
			statements: freeTierD1StatementsPerInvocation
		},
		{
			name: 'an endpoint that did not answer',
			subscriptions: unavailable,
			level: 'warn' as const,
			statements: freeTierD1StatementsPerInvocation
		},
		{
			name: 'a response this build cannot read',
			subscriptions: unparsed,
			level: 'warn' as const,
			statements: freeTierD1StatementsPerInvocation
		},
		{
			name: 'a rate plan this build does not know',
			subscriptions: unrecognisedRatePlan,
			level: 'warn' as const,
			statements: freeTierD1StatementsPerInvocation
		}
	])(
		'sizes the allowance from $name and reports it once',
		async ({ subscriptions, level, statements }) => {
			const { ui, reported } = recordingUi();
			const established = await establishWorkersPlan({
				ui,
				api: { listAccountSubscriptions: () => Promise.resolve(subscriptions) }
			});

			expect({
				statements: established,
				levels: reported.map((report) => report.level)
			}).toStrictEqual({ statements, levels: [level] });
		}
	);

	// Each unknown calls for a different answer from the operator, so one shared
	// message for all of them would not tell them which happened.
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

	it('takes the plan the operator states, without reading the subscriptions', async () => {
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
			statements: established,
			listings,
			levels: reported.map((report) => report.level)
		}).toStrictEqual({
			statements: paidTierD1StatementsPerInvocation,
			listings: 0,
			levels: ['info']
		});
	});
});
