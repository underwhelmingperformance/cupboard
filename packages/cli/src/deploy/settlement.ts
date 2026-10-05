import {
	localStepStallWindowMs,
	type LocalStepStatus,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import type { Reporter, StepLog } from '@cupboard/reporter';

import { type Delay, delayMs, throwIfAborted } from '../abort.ts';
import { LocalStepUnreachedError } from '../errors.ts';

import { stalledTenantText } from './local-step-samples.ts';

export interface SettlementClient {
	status(): Promise<LocalStepStatus>;
	wake(): Promise<LocalStepWakeResponse>;
}

export interface SettlementOptions {
	readonly signal?: AbortSignal;
	readonly url?: URL;
	readonly delay?: Delay;
	readonly now?: () => number;
}

/**
 * How long the settlement waits between two reads of `localStep.status`.
 */
export const localStepPollIntervalMs = 5000;

/**
 * Waits until every active or suspended tenant has completed the server's
 * required schema and data work. When tenants are pending, the settlement calls
 * `localStep.wake` once, which enqueues a wake for every pending tenant that
 * is not working. Each woken tenant object then continues its own work on its
 * alarm. The settlement reads `localStep.status` every
 * `localStepPollIntervalMs` until no tenant is pending. It writes the counts to
 * the step log whenever they change, and a warning the first time that a
 * tenant appears in the stalled sample.
 *
 * It fails with `LocalStepUnreachedError` when tenants are pending, none of
 * them is currently classified as working, and the wake is at least
 * `localStepStallWindowMs` old. The tenant objects do not depend on the
 * settlement: an object that is working continues when the settlement fails
 * or is interrupted, and one that has stopped waits for the next wake.
 */
export async function settleTenants(
	client: SettlementClient,
	reporter: Reporter,
	options: SettlementOptions = {}
): Promise<LocalStepStatus> {
	throwIfAborted(options.signal);
	const initial = await client.status();

	if (initial.pending === 0) {
		return initial;
	}

	return reporter.steps(
		'Advancing tenant migrations',
		(log) => waitForTenants(client, log, options),
		{ humanLabel: 'Updating tenants' }
	);
}

async function waitForTenants(
	client: SettlementClient,
	log: StepLog,
	options: SettlementOptions
): Promise<LocalStepStatus> {
	const now = options.now ?? Date.now;

	throwIfAborted(options.signal);
	const woken = await client.wake();
	const wokenAt = now();
	const warned = new Set<string>();
	let previous: LocalStepStatus | undefined;

	log.message(
		`Enqueued wakes for ${String(woken.enqueued)} of ${String(woken.pending)} pending tenants`,
		{ level: 'debug' }
	);
	log.message(
		'Cancelling this command stops only the wait; tenant migrations continue on the server.'
	);

	for (;;) {
		throwIfAborted(options.signal);
		const status = await client.status();

		if (previous === undefined || haveCountsChanged(previous, status)) {
			log.message(
				`Tenants: ${String(status.ready)} ready, ${String(status.working)} migrating, ${String(status.stalled)} need attention, ${String(status.unwoken)} waiting to start`
			);
		}

		for (const tenant of status.stalledSample) {
			if (warned.has(tenant.tenant)) {
				continue;
			}

			warned.add(tenant.tenant);
			log.warn('Stalled', stalledTenantText(tenant), {
				humanMessage: `${tenant.tenant}: tenant updates need attention. Inspect deployment status with --debug for the diagnostic.`
			});
		}

		previous = status;

		if (status.pending === 0) {
			return status;
		}

		if (status.working === 0 && now() - wokenAt >= localStepStallWindowMs) {
			throw new LocalStepUnreachedError(
				{ kind: 'stalled', status },
				options.url
			);
		}

		await delayMs(localStepPollIntervalMs, {
			signal: options.signal,
			delay: options.delay
		});
	}
}

function haveCountsChanged(
	previous: LocalStepStatus,
	status: LocalStepStatus
): boolean {
	return (
		previous.required !== status.required ||
		previous.ready !== status.ready ||
		previous.working !== status.working ||
		previous.stalled !== status.stalled ||
		previous.unwoken !== status.unwoken
	);
}
