import {
	freeTierD1StatementsPerInvocation,
	paidTierD1StatementsPerInvocation
} from '@cupboard/protocol/platform';

import type { AccountSubscriptions, CloudflareApi } from './cloudflare-api.ts';

/**
 * Why the deploy could not establish the account's Workers plan. Each cause
 * calls for a different answer from the operator, so they are reported apart.
 */
export type WorkersPlanUnknownCause =
	// The deployment token cannot read the account's subscriptions, which is the
	// common case for a token scoped to Workers alone.
	| { readonly cause: 'subscriptions-unreadable' }
	// The subscriptions endpoint did not answer. The client makes no attempt of
	// its own, so one fault is enough to reach this.
	| { readonly cause: 'subscriptions-unavailable' }
	// The subscriptions endpoint answered with a body this build cannot read.
	| { readonly cause: 'subscriptions-unparsed' }
	// The account has a Workers subscription whose rate plan is neither a known
	// paid plan nor the known free plan.
	| { readonly cause: 'unrecognised-rate-plan'; readonly ratePlanId: string };

export type WorkersPlan =
	| { readonly kind: 'paid'; readonly ratePlanId: string }
	| { readonly kind: 'free' }
	| ({ readonly kind: 'unknown' } & WorkersPlanUnknownCause);

/**
 * The Workers rate plans that carry the paid per-invocation limits, from
 * Cloudflare's dashboard vocabulary. Matching `workers_paid` alone would
 * classify an enterprise or trial account as free.
 */
const paidRatePlanIds: ReadonlySet<string> = new Set([
	'workers_paid',
	'workers_paid_nocost',
	'workers_trial',
	'workers_ent',
	'workers_ent_paygo',
	'workers_ent_contract',
	'workers_paid_ent_paygo',
	'workers_paid_ent_contract',
	'workers_paid_ent_tryout'
]);

const freeRatePlanIds: ReadonlySet<string> = new Set(['workers_free']);

// Every way of not reading the subscriptions, each with its own cause. Naming
// them all here is what makes a new one from the API a type error rather than a
// silent mapping onto the wrong cause.
const unreadSubscriptionCauses = {
	unreadable: 'subscriptions-unreadable',
	unavailable: 'subscriptions-unavailable',
	unparsed: 'subscriptions-unparsed'
} as const satisfies Record<
	Exclude<AccountSubscriptions['kind'], 'listed'>,
	WorkersPlanUnknownCause['cause']
>;

// A subscription in any other state is not in force, so its rate plan says
// nothing about what the account may run today.
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
 * Reads the account's Workers plan from its subscriptions.
 *
 * An account with no active Workers subscription is on Workers Free: the free
 * plan is the absence of a paid one, and some accounts also carry a positive
 * `workers_free` subscription. A Workers subscription whose rate plan this
 * build does not know is reported as unknown rather than guessed at, because
 * guessing paid makes every later run fail at runtime.
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
 * The D1 statements one invocation may run on `plan`. An unknown plan gets the
 * free figure: a pass that runs out of a smaller allowance defers its remaining
 * work and resumes, whereas a pass that assumes more than the plan allows fails
 * a statement at runtime.
 */
export function d1StatementsFor(plan: WorkersPlan): number {
	return plan.kind === 'paid'
		? paidTierD1StatementsPerInvocation
		: freeTierD1StatementsPerInvocation;
}

/**
 * What an operator may state when the deployment token cannot read the
 * account's subscriptions.
 */
export type WorkersPlanOverride = 'free' | 'paid';

interface WorkersPlanUi {
	info(message: string): void;
	warn(message: string): void;
}

export interface EstablishWorkersPlanOptions {
	readonly api: Pick<CloudflareApi, 'listAccountSubscriptions'>;
	readonly ui: WorkersPlanUi;
	readonly override?: WorkersPlanOverride;
	readonly signal?: AbortSignal;
}

const unknownPlanExplanations: Readonly<
	Record<WorkersPlanUnknownCause['cause'], string>
> = {
	'subscriptions-unreadable':
		"The deployment token cannot read the account's subscriptions.",
	'subscriptions-unavailable':
		"Cloudflare did not answer for the account's subscriptions.",
	'subscriptions-unparsed':
		'Cloudflare returned account subscriptions this build cannot read.',
	'unrecognised-rate-plan':
		'The account has a Workers subscription on a rate plan this build does ' +
		'not know.'
};

/**
 * Establishes the D1 statements one invocation may run on this account, and
 * reports what the plan was read from.
 *
 * Detection is best effort: a deployment token scoped to Workers alone gets a
 * 403 from the subscriptions endpoint, which is the common case. Each way of
 * failing to establish the plan is reported on its own, because they call for
 * different answers from the operator, and all of them leave the deployment on
 * the free figure. `--workers-plan` states the plan for an operator whose token
 * cannot read it.
 *
 * Only the subscriptions request can fail here, and it reports rather than
 * throws, so the single way out of this function other than a figure is the
 * operator cancelling the run.
 */
export async function establishWorkersPlan({
	api,
	ui,
	override,
	signal
}: EstablishWorkersPlanOptions): Promise<number> {
	if (override !== undefined) {
		const stated =
			override === 'paid'
				? paidTierD1StatementsPerInvocation
				: freeTierD1StatementsPerInvocation;
		ui.info(
			`Sizing D1 statement budgets for Workers ${override}, as \`--workers-plan\` states: ${String(stated)} statements per invocation.`
		);

		return stated;
	}

	const plan = workersPlanFrom(await api.listAccountSubscriptions(signal));

	if (plan.kind === 'paid') {
		ui.info(
			`The account is on Workers Paid (${plan.ratePlanId}), so one invocation may run ${String(d1StatementsFor(plan))} D1 statements.`
		);

		return d1StatementsFor(plan);
	}

	if (plan.kind === 'free') {
		ui.info(
			`The account has no paid Workers subscription, so one invocation may run ${String(d1StatementsFor(plan))} D1 statements.`
		);

		return d1StatementsFor(plan);
	}

	ui.warn(
		`${unknownPlanExplanations[plan.cause]} Sizing D1 statement budgets for ` +
			`Workers Free (${String(d1StatementsFor(plan))} statements per ` +
			'invocation). Pass `--workers-plan paid` to raise them.'
	);

	return d1StatementsFor(plan);
}
