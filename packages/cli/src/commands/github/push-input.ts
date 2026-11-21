import { type RepositoryIdentity } from '../oidc-trust/github.ts';

import { type DiscoveredPublishingJob } from './discovery.ts';
import { evaluateExpression } from './job-condition.ts';

export type RunPush =
	| { readonly outcome: 'resolved'; readonly push: boolean }
	| { readonly outcome: 'unresolved'; readonly reason: string };

/**
The `push` input of one modelled run of a job: the literal input, or the
value of the job's push expression for the run. `ref` is the run's
`github.ref` when the model fixes it. The input defaults to true, and the
installable workflow has no such input.
*/
export function runPushInput(
	job: DiscoveredPublishingJob,
	identity: RepositoryIdentity,
	run: { readonly event: string; readonly ref?: string }
): RunPush {
	const expression = job.pushExpression;

	if (expression === undefined) {
		return {
			outcome: 'resolved',
			push: job.kind !== 'flake' || job.inputs.push !== false
		};
	}

	const result = evaluateExpression(expression.expression, {
		event: run.event,
		repository: { fullName: identity.fullName, id: identity.repositoryId },
		...(run.ref !== undefined && { ref: run.ref }),
		inputs: expression.inputs
	});

	if (result.outcome === 'unsupported') {
		return {
			outcome: 'unresolved',
			reason: `the check cannot evaluate ${result.part} in the push input for ${run.event} runs, so it cannot determine whether those runs publish or only read`
		};
	}

	if (typeof result.value !== 'boolean') {
		const shown =
			result.value === undefined ? 'null' : JSON.stringify(result.value);

		return {
			outcome: 'unresolved',
			reason: `the push input evaluates to ${shown} for ${run.event} runs, but the input accepts only a boolean`
		};
	}

	return { outcome: 'resolved', push: result.value };
}
