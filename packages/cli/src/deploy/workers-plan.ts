import {
	type WorkersInvocationAllowance,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';

import type { AccountSubscriptions, CloudflareApi } from './cloudflare-api.ts';

/**
 * Why subscription lookup could not determine the Workers plan.
 */
export type WorkersPlanUnknownCause =
	| { readonly cause: 'subscriptions-unreadable' }
	| { readonly cause: 'subscriptions-unavailable' }
	| { readonly cause: 'subscriptions-unparsed' }
	| { readonly cause: 'unrecognised-rate-plan'; readonly ratePlanId: string };

export type WorkersPlan =
	| { readonly kind: 'paid'; readonly ratePlanId: string }
	| { readonly kind: 'free' }
	| ({ readonly kind: 'unknown' } & WorkersPlanUnknownCause);

// Cloudflare documents WORKERS_PAID in its tenant subscription reference.
// Other Workers products use the conservative allowance until verified.
const paidRatePlanIds: ReadonlySet<string> = new Set(['workers_paid']);

const freeRatePlanIds: ReadonlySet<string> = new Set(['workers_free']);

const unreadSubscriptionCauses = {
	unreadable: 'subscriptions-unreadable',
	unavailable: 'subscriptions-unavailable',
	unparsed: 'subscriptions-unparsed'
} as const satisfies Record<
	Exclude<AccountSubscriptions['kind'], 'listed'>,
	WorkersPlanUnknownCause['cause']
>;

const activeSubscriptionStates: ReadonlySet<string> = new Set([
	'trial',
	'provisioned',
	'paid',
	'awaitingpayment'
]);

function isActive(state: string | undefined): boolean {
	return (
		state !== undefined && activeSubscriptionStates.has(state.toLowerCase())
	);
}

/**
 * Interprets active Workers subscriptions using the recognised rate-plan IDs.
 * An unrecognised Workers ID produces an unknown result. If there is no active
 * Workers subscription, the result is Free.
 */
export function workersPlanFrom(listed: AccountSubscriptions): WorkersPlan {
	if (listed.kind !== 'listed') {
		return { kind: 'unknown', cause: unreadSubscriptionCauses[listed.kind] };
	}

	const workersRatePlanIds = listed.subscriptions.flatMap((subscription) => {
		const ratePlanId = subscription.ratePlanId?.toLowerCase();

		return ratePlanId?.includes('workers') === true &&
			isActive(subscription.state)
			? [ratePlanId]
			: [];
	});

	const paid = workersRatePlanIds.find((ratePlanId) =>
		paidRatePlanIds.has(ratePlanId)
	);

	if (paid !== undefined) {
		return { kind: 'paid', ratePlanId: paid };
	}

	const unrecognised = workersRatePlanIds.find(
		(ratePlanId) => !freeRatePlanIds.has(ratePlanId)
	);

	return unrecognised === undefined
		? { kind: 'free' }
		: {
				kind: 'unknown',
				cause: 'unrecognised-rate-plan',
				ratePlanId: unrecognised
			};
}

/**
 * Returns the configured subrequest allowance for the detected plan. An unknown plan
 * uses the Free limit so a failed lookup does not require a Paid subscription.
 */
export function invocationAllowanceFor(
	plan: WorkersPlan
): WorkersInvocationAllowance {
	return plan.kind === 'paid'
		? workersInvocationAllowances.paid
		: workersInvocationAllowances.free;
}

/**
 * An explicit plan selection that bypasses subscription lookup.
 */
export type WorkersPlanOverride = 'free' | 'paid';

interface WorkersPlanUi {
	info(message: string): void;
	warn(message: string): void;
}

export type WorkersAllowanceSource =
	| { readonly kind: 'override'; readonly plan: WorkersPlanOverride }
	| { readonly kind: 'subscription'; readonly plan: WorkersPlan }
	| { readonly kind: 'offline' }
	| { readonly kind: 'configuration' };

export interface WorkersAllowance {
	readonly subrequests: number;
	readonly source: WorkersAllowanceSource;
}

export function workersAllowanceSourceText(
	source: WorkersAllowanceSource
): string {
	if (source.kind === 'override') {
		return `Explicit --workers-plan ${source.plan}`;
	}
	if (source.kind === 'offline') {
		return 'Offline default; subscriptions not queried';
	}
	if (source.kind === 'configuration') {
		return 'Worker configuration';
	}
	if (source.plan.kind === 'paid') {
		return `Active subscription: ${source.plan.ratePlanId}`;
	}
	if (source.plan.kind === 'free') {
		return 'No active paid Workers subscription';
	}
	return source.plan.cause === 'unrecognised-rate-plan'
		? `Free fallback: unrecognised rate plan ${source.plan.ratePlanId}`
		: `Free fallback: ${unknownPlanExplanations[source.plan.cause]}`;
}

export interface EstablishWorkersPlanOptions {
	readonly api: Pick<CloudflareApi, 'listAccountSubscriptions'>;
	readonly ui: WorkersPlanUi;
	readonly override?: WorkersPlanOverride;
	readonly signal?: AbortSignal;
}

const unknownPlanExplanations: Readonly<
	Record<
		Exclude<WorkersPlanUnknownCause['cause'], 'unrecognised-rate-plan'>,
		string
	>
> = {
	'subscriptions-unreadable':
		"The deployment token cannot read the account's subscriptions.",
	'subscriptions-unavailable':
		"Could not retrieve the account's subscriptions from Cloudflare.",
	'subscriptions-unparsed':
		'Cloudflare returned account subscriptions this build cannot read.'
};

/**
 * Chooses a subrequest allowance and reports whether it came from subscription lookup
 * or an explicit override. Lookup failures use the Free allowance and report
 * the cause. Request cancellation propagates to stop deployment.
 */
export async function establishWorkersPlan({
	api,
	ui,
	override,
	signal
}: EstablishWorkersPlanOptions): Promise<WorkersAllowance> {
	if (override !== undefined) {
		const stated = workersInvocationAllowances[override].subrequests;
		ui.info(
			`Using ${String(stated)} subrequests per invocation for Workers ${override} (\`--workers-plan\`).`
		);

		return {
			subrequests: stated,
			source: { kind: 'override', plan: override }
		};
	}

	const plan = workersPlanFrom(await api.listAccountSubscriptions(signal));

	if (plan.kind === 'paid') {
		ui.info(
			`Detected Workers Paid (${plan.ratePlanId}); using ${String(invocationAllowanceFor(plan).subrequests)} subrequests per invocation.`
		);

		return {
			subrequests: invocationAllowanceFor(plan).subrequests,
			source: { kind: 'subscription', plan }
		};
	}

	if (plan.kind === 'free') {
		ui.info(
			`No active paid Workers subscription was recognised; using ${String(invocationAllowanceFor(plan).subrequests)} subrequests per invocation.`
		);

		return {
			subrequests: invocationAllowanceFor(plan).subrequests,
			source: { kind: 'subscription', plan }
		};
	}

	const explanation =
		plan.cause === 'unrecognised-rate-plan'
			? `Unrecognised Workers rate plan: ${plan.ratePlanId}.`
			: unknownPlanExplanations[plan.cause];
	ui.warn(
		`${explanation} Using the Workers Free allowance ` +
			`(${String(invocationAllowanceFor(plan).subrequests)} subrequests per invocation). ` +
			'If this account is on Workers Paid, pass `--workers-plan paid`.'
	);

	return {
		subrequests: invocationAllowanceFor(plan).subrequests,
		source: { kind: 'subscription', plan }
	};
}
