import {
	type LocalStep,
	type LocalStepStatus,
	type LocalStepWakeBody,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import type { Reporter } from '@cupboard/reporter';

import { throwIfAborted } from '../abort.ts';
import { LocalStepUnreachedError } from '../errors.ts';

export interface SettlementClient {
	status(input: { requiredStep: LocalStep }): Promise<LocalStepStatus>;
	wake(input: LocalStepWakeBody): Promise<LocalStepWakeResponse>;
}

export interface SettlementOptions {
	readonly requiredStep: LocalStep;
	readonly limit: number;
	readonly maxPasses: number;
	readonly signal?: AbortSignal;
}

/**
 * Advances bounded batches, stopping at the requested step or pass limit. It
 * also stops when a wake selects no tenant while tenants are still pending.
 * The wake selects tenants below the server's step, wrapping round the whole
 * list, so an empty wake means that no tenant is below that step and further
 * wakes would select none either.
 */
export async function settleTenants(
	client: SettlementClient,
	reporter: Reporter,
	options: SettlementOptions
): Promise<LocalStepStatus> {
	const query = { requiredStep: options.requiredStep };
	throwIfAborted(options.signal);
	let status = await client.status(query);
	const reported = new Set<string>();
	for (let pass = 0; status.pending > 0 && pass < options.maxPasses; pass++) {
		throwIfAborted(options.signal);
		const result = await reporter.phase('Advancing tenant migrations', () =>
			client.wake({ limit: options.limit })
		);
		reportOutcomes(result.outcomes, reporter, reported);
		status = await client.status(query);

		if (result.outcomes.length === 0) {
			break;
		}
	}
	throwIfAborted(options.signal);
	if (status.pending > 0) {
		throw new LocalStepUnreachedError(
			status.pending,
			options.requiredStep,
			status.stragglers
		);
	}
	return status;
}

function reportOutcomes(
	outcomes: LocalStepWakeResponse['outcomes'],
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
