import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	type LocalStep,
	localStepSchema,
	type LocalStepStatus,
	type LocalStepSweep,
	localStepSweepPaceSeconds,
	type LocalStepWakeBody,
	type LocalStepWakeOutcomes,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import type { Reporter, StepLog } from '@cupboard/reporter';

import { type Delay, delayMs, throwIfAborted } from '../abort.ts';
import { type LocalStepShortfall, LocalStepUnreachedError } from '../errors.ts';

import { describeStuckTenant } from './wake-outcomes.ts';

export interface SettlementClient {
	status(input: { requiredStep?: LocalStep }): Promise<LocalStepStatus>;
	wake(input: LocalStepWakeBody): Promise<LocalStepWakeResponse>;
}

export interface SettlementOptions {
	/**
	 * The step for the status counts. Without it, the server counts against the
	 * required local step and reports that step with the counts. The wake always
	 * uses the server's required local step.
	 */
	readonly requiredStep?: LocalStep;
	readonly limit: number;
	readonly signal?: AbortSignal;
	readonly delay?: Delay;
}

/**
 * The largest number of chains that the settlement starts again. It starts
 * one whenever the sweep is idle with tenants still pending, and fails when
 * the sweep is idle once more after the last.
 */
export const maxChainRestarts = 3;

/**
 * Waits until every active or suspended tenant has recorded the required
 * step, while the server's sweep chain wakes the tenants. The settlement first
 * calls `localStep.wake`. That wake runs a batch and starts a chain, unless a
 * chain that has not confirmed a stall has the lease, and the chain wakes the
 * following batches. The settlement then polls `localStep.status` every
 * `localStepSweepPaceSeconds` until no tenant is pending. It writes a progress
 * line whenever the pending count, the state of the sweep, or the count of
 * tenant wakes without work changes. The line includes the chain, its link and
 * each tenant in the last batch that did no work, with the step that the
 * tenant had recorded. When a wake reports that it could not start or end a
 * chain, the settlement writes a warning with the error.
 *
 * The server decides when the sweep has stalled: the chain confirms a stall
 * once every pending tenant has completed a wake without work, or has failed
 * too many wakes in a row, since the last batch in which a tenant did work. A
 * large tenant that does some work on every wake therefore keeps the chain
 * running. The settlement fails as soon as the sweep reports `stalled`. The
 * error lists the stragglers and the last batch's outcomes, and the chain
 * keeps retrying on the server.
 *
 * A wake selects tenants below the server's required local step, so a wake
 * that selects no tenant means that no tenant is below that step. Another
 * wake or a chain can have recorded the last pending tenants since the
 * settlement read the status, so the settlement reads the status again. It
 * returns that status when no tenant is pending. Otherwise the pending
 * tenants have reached the server's required step but not the step that the
 * caller counts against, no chain wakes them, and the settlement fails.
 *
 * When the sweep is idle with tenants still pending, the chain stopped or did
 * not start. The settlement then wakes again to start a new chain, at most
 * `maxChainRestarts` times. The restart count resets whenever the pending
 * count falls. A chain that stopped while running keeps its lease and reads as
 * running until the lease expires, so the settlement waits for up to the
 * lease's length before it restarts the chain. The settlement has no timeout:
 * it keeps polling while tenants do work.
 */
export async function settleTenants(
	client: SettlementClient,
	reporter: Reporter,
	options: SettlementOptions
): Promise<LocalStepStatus> {
	throwIfAborted(options.signal);
	const initial = await client.status(statusQuery(options));

	if (initial.pending === 0) {
		return initial;
	}

	return reporter.steps('Advancing tenant migrations', (log) =>
		observeChain(client, log, options)
	);
}

function statusQuery(options: SettlementOptions): {
	requiredStep?: LocalStep;
} {
	return options.requiredStep === undefined
		? {}
		: { requiredStep: options.requiredStep };
}

function shortfallOf(status: LocalStepStatus): LocalStepShortfall {
	return {
		pending: status.pending,
		requiredStep: localStepSchema.parse(status.required),
		stragglers: status.stragglers.map((tenant) => tenantIdSchema.parse(tenant))
	};
}

async function observeChain(
	client: SettlementClient,
	log: StepLog,
	options: SettlementOptions
): Promise<LocalStepStatus> {
	const query = statusQuery(options);
	const reported = new Set<string>();
	const report = (outcomes: LocalStepWakeOutcomes): void => {
		reportOutcomes(outcomes, log, reported);
	};
	// Returns the status that ends the settlement when the wake selected no
	// tenant because none is pending any more.
	const wake = async (): Promise<LocalStepStatus | undefined> => {
		throwIfAborted(options.signal);
		const woken = await client.wake({ limit: options.limit });
		report(woken.outcomes);

		if (woken.chain.kind === 'failed') {
			log.warn(
				'Sweep chain',
				`The control Worker could not start or end the sweep chain: ${woken.chain.error}`
			);
		}

		if (woken.outcomes.length > 0) {
			return undefined;
		}

		const status = await client.status(query);

		if (status.pending === 0) {
			return status;
		}

		throw new LocalStepUnreachedError(
			{ kind: 'above-required' },
			shortfallOf(status)
		);
	};

	const settled = await wake();

	if (settled !== undefined) {
		return settled;
	}

	let restarts = 0;
	let previous: LocalStepStatus | undefined;

	for (;;) {
		await delayMs(localStepSweepPaceSeconds * 1000, {
			signal: options.signal,
			delay: options.delay
		});
		throwIfAborted(options.signal);
		const status = await client.status(query);

		if (status.sweep.state !== 'idle') {
			report(status.sweep.outcomes);
		}

		if (hasProgressChanged(previous, status)) {
			log.message(describeProgress(status));
		}

		if (previous !== undefined && status.pending < previous.pending) {
			restarts = 0;
		}

		previous = status;

		if (status.pending === 0) {
			return status;
		}

		if (status.sweep.state === 'running') {
			continue;
		}

		if (status.sweep.state === 'stalled') {
			throw new LocalStepUnreachedError(
				{ kind: 'stalled', outcomes: status.sweep.outcomes },
				shortfallOf(status)
			);
		}

		if (restarts === maxChainRestarts) {
			throw new LocalStepUnreachedError(
				{ kind: 'chain-stopped', outcomes: status.sweep.last?.outcomes ?? [] },
				shortfallOf(status)
			);
		}

		restarts += 1;
		const restarted = await wake();

		if (restarted !== undefined) {
			return restarted;
		}
	}
}

function hasProgressChanged(
	previous: LocalStepStatus | undefined,
	status: LocalStepStatus
): boolean {
	if (previous === undefined) {
		return true;
	}

	return (
		status.pending !== previous.pending ||
		status.sweep.state !== previous.sweep.state ||
		wokenWithoutWork(status.sweep) !== wokenWithoutWork(previous.sweep)
	);
}

function wokenWithoutWork(sweep: LocalStepSweep): number {
	return sweep.state === 'idle' ? 0 : sweep.wokenWithoutWork;
}

function describeProgress(status: LocalStepStatus): string {
	const tenants = `${String(status.pending)} of ${String(status.ready + status.pending)} tenants below local step ${String(status.required)}`;
	const { sweep } = status;

	if (sweep.state === 'idle') {
		return `${tenants} · sweep idle`;
	}

	const chain = `chain ${sweep.chain} at link ${String(sweep.link)}`;
	const stuck = sweep.outcomes.flatMap((outcome) => {
		const description = describeStuckTenant(outcome);

		return description === undefined ? [] : [description];
	});
	const withoutWork =
		sweep.wokenWithoutWork === 0
			? ''
			: ` · no work done in the last ${sweep.wokenWithoutWork === 1 ? 'tenant wake' : `${String(sweep.wokenWithoutWork)} tenant wakes`}`;

	return `${tenants} · sweep ${sweep.state}, ${chain}${withoutWork}${stuck.length === 0 ? '' : ` · ${stuck.join(', ')}`}`;
}

function reportOutcomes(
	outcomes: LocalStepWakeOutcomes,
	log: StepLog,
	reported: Set<string>
): void {
	for (const outcome of outcomes) {
		if (
			outcome.kind === 'recorded' ||
			outcome.kind === 'advanced' ||
			reported.has(outcome.tenant)
		) {
			continue;
		}
		reported.add(outcome.tenant);
		log.warn(
			outcome.tenant,
			outcome.kind === 'unconfigured'
				? 'Tenant creation is incomplete. Repeat its creation with the original configuration.'
				: 'Tenant migration failed. Inspect the tenant Worker logs before retrying.'
		);
	}
}
