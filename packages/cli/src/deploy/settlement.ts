import {
	type LocalStep,
	type LocalStepStatus,
	localStepSweepPaceSeconds,
	type LocalStepWakeBody,
	type LocalStepWakeOutcomes,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import type { Reporter } from '@cupboard/reporter';

import { type Delay, delayMs, throwIfAborted } from '../abort.ts';
import { LocalStepUnreachedError } from '../errors.ts';

export interface SettlementClient {
	status(input: { requiredStep: LocalStep }): Promise<LocalStepStatus>;
	wake(input: LocalStepWakeBody): Promise<LocalStepWakeResponse>;
}

export interface SettlementOptions {
	readonly requiredStep: LocalStep;
	readonly limit: number;
	readonly signal?: AbortSignal;
	readonly delay?: Delay;
}

/**
 * How many times a chain whose lease expired with tenants still pending is
 * started again before the settlement gives up.
 */
export const maxChainRestarts = 3;

/**
 * Brings every active tenant to the required step by observing the server's
 * sweep chain. One wake runs the first batch and starts the chain, which
 * keeps waking batches on its own; this then polls `localStep.status` at the
 * chain's pace until nothing is pending. A chain that stalls, because a batch
 * advanced nobody, fails the settlement naming the stragglers and that
 * batch's outcomes, while the chain keeps retrying on the server. A chain
 * that died, because its lease expired, is started again, at most
 * `maxChainRestarts` times. There is no pass limit and no wall-clock timeout:
 * the settlement waits while the chain makes progress and stops as soon as it
 * cannot.
 */
export async function settleTenants(
	client: SettlementClient,
	reporter: Reporter,
	options: SettlementOptions
): Promise<LocalStepStatus> {
	const query = { requiredStep: options.requiredStep };
	const reported = new Set<string>();
	const report = (outcomes: LocalStepWakeOutcomes): void => {
		reportOutcomes(outcomes, reporter, reported);
	};
	const wake = async (): Promise<void> => {
		throwIfAborted(options.signal);
		const woken = await client.wake({ limit: options.limit });
		report(woken.outcomes);
	};

	throwIfAborted(options.signal);
	let status = await client.status(query);

	if (status.pending === 0) {
		return status;
	}

	return reporter.phase('Advancing tenant migrations', async () => {
		await wake();
		let restarts = 0;

		for (;;) {
			await delayMs(localStepSweepPaceSeconds * 1000, {
				signal: options.signal,
				delay: options.delay
			});
			throwIfAborted(options.signal);
			status = await client.status(query);
			const outcomes = lastOutcomes(status);
			report(outcomes);

			if (status.pending === 0) {
				return status;
			}

			if (status.sweep.state === 'running') {
				continue;
			}

			if (restarts === maxChainRestarts || status.sweep.state === 'stalled') {
				throw new LocalStepUnreachedError(
					status.pending,
					options.requiredStep,
					status.stragglers,
					outcomes
				);
			}

			restarts += 1;
			await wake();
		}
	});
}

function lastOutcomes(status: LocalStepStatus): LocalStepWakeOutcomes {
	if (status.sweep.state === 'idle') {
		return status.sweep.last?.outcomes ?? [];
	}

	return status.sweep.outcomes;
}

function reportOutcomes(
	outcomes: LocalStepWakeOutcomes,
	reporter: Reporter,
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
		reporter.warn(
			outcome.tenant,
			outcome.kind === 'unconfigured'
				? 'Tenant creation is incomplete. Repeat its creation with the original configuration.'
				: 'Tenant migration failed. Inspect the tenant Worker logs before retrying.'
		);
	}
}
