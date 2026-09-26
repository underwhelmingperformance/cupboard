import {
	hasDoneWork,
	type LocalStepSweepFailingTenant,
	type LocalStepWakeOutcome
} from '@cupboard/protocol/deployment';

/**
 * Describes one tenant's outcome in a wake, with the step that the tenant had
 * recorded when it has more work to do.
 */
export function describeWakeOutcome(outcome: LocalStepWakeOutcome): string {
	switch (outcome.kind) {
		case 'recorded': {
			return outcome.progressed
				? `${outcome.tenant} recorded step ${String(outcome.step)}`
				: `${outcome.tenant} did no work (step ${String(outcome.step)} recorded again)`;
		}

		case 'advanced': {
			const recorded =
				outcome.step === undefined
					? 'no step recorded'
					: `step ${String(outcome.step)} recorded`;

			return outcome.progressed
				? `${outcome.tenant} did work and has more to do (${recorded})`
				: `${outcome.tenant} did no work (${recorded})`;
		}

		case 'unconfigured': {
			return `${outcome.tenant} unconfigured`;
		}

		case 'failed': {
			return `${outcome.tenant} failed (${outcome.error})`;
		}
	}
}

/**
 * Describes a tenant that did no work in a wake, or returns `undefined` for a
 * tenant that did work.
 */
export function describeStuckTenant(
	outcome: LocalStepWakeOutcome
): string | undefined {
	return hasDoneWork(outcome) ? undefined : describeWakeOutcome(outcome);
}

/**
 * Describes a tenant whose recent wakes failed.
 */
export function describeFailingTenant(
	failing: LocalStepSweepFailingTenant
): string {
	const wakes =
		failing.failures === 1
			? '1 wake'
			: `${String(failing.failures)} wakes in a row`;

	return `${failing.tenant} failed ${wakes} (${failing.error})`;
}
