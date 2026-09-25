import {
	type LocalStepSweep,
	localStepWakeBodySchema,
	type LocalStepWakeOutcomes,
	type ParsedDeploymentTransitionsResponse
} from '@cupboard/protocol/deployment';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { type Command, InvalidArgumentError } from 'commander';

import { type Delay } from '../abort.ts';
import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { type SettlementClient, settleTenants } from '../deploy/settlement.ts';
import { deploymentUrlArgument } from '../url-argument.ts';

function parseBatchLimit(value: string): number {
	const parsed = localStepWakeBodySchema.safeParse({ limit: Number(value) });
	if (!parsed.success) {
		throw new InvalidArgumentError(
			'Batch size must be an integer from 1 to 100.'
		);
	}
	return parsed.data.limit;
}

interface ResumeOptions {
	readonly limit: number;
}

export interface DeploymentClient {
	transitions(): Promise<ParsedDeploymentTransitionsResponse>;
	readonly localStep: SettlementClient;
}

export interface DeploymentResumeOptions {
	readonly limit: number;
	readonly signal?: AbortSignal;
	readonly delay?: Delay;
}

/**
 * Shows each recorded schema transition, the local step they require of every
 * active tenant now, how many tenants have reached it, and how the sweep
 * chain that advances the rest stands.
 */
export async function runDeploymentStatus(
	reporter: Reporter,
	client: DeploymentClient
): Promise<void> {
	const transitions = await client.transitions();
	const status = await client.localStep.status({
		requiredStep: transitions.requiredLocalStep
	});
	const transitionRows =
		transitions.transitions.length === 0
			? [{ label: 'Transitions', value: 'none recorded' }]
			: transitions.transitions.map((transition) => ({
					label: `Transition ${transition.id}`,
					value: `${transition.state} since ${formatTimestamp(transition.updatedAt)}`
				}));

	reporter.result({
		kind: 'deployment-status',
		data: { ...transitions, ...status },
		rows: [
			...transitionRows,
			{ label: 'Required local step', value: String(status.required) },
			{ label: 'Ready tenants', value: String(status.ready) },
			{ label: 'Pending tenants', value: String(status.pending) },
			{
				label: 'Pending sample',
				value: status.stragglers.join(', ') || '(none)'
			},
			...sweepRows(status.sweep)
		]
	});
}

function sweepRows(sweep: LocalStepSweep): ResultRow[] {
	if (sweep.state === 'idle') {
		return sweep.last === undefined
			? [{ label: 'Sweep chain', value: 'idle' }]
			: [
					{
						label: 'Sweep chain',
						value: `idle · last chain ${sweep.last.chain} ended at link ${String(sweep.last.link)} · ${formatTimestamp(sweep.last.updatedAt)}`
					},
					{ label: 'Last batch', value: describeBatch(sweep.last.outcomes) }
				];
	}

	return [
		{
			label: 'Sweep chain',
			value: `${sweep.state} · chain ${sweep.chain} at link ${String(sweep.link)} · ${formatTimestamp(sweep.updatedAt)} · next batch ${formatTimestamp(sweep.nextAt)}`
		},
		{ label: 'Last batch', value: describeBatch(sweep.outcomes) }
	];
}

// Counts the batch by outcome and names the tenants that need repair.
function describeBatch(outcomes: LocalStepWakeOutcomes): string {
	if (outcomes.length === 0) {
		return '(none)';
	}

	const counts = new Map<string, number>();
	const repairs: string[] = [];

	for (const outcome of outcomes) {
		counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);

		if (outcome.kind === 'unconfigured' || outcome.kind === 'failed') {
			repairs.push(`${outcome.tenant} ${outcome.kind}`);
		}
	}

	const summary = [...counts]
		.map(([kind, count]) => `${String(count)} ${kind}`)
		.join(', ');

	return repairs.length === 0 ? summary : `${summary} · ${repairs.join(', ')}`;
}

/**
 * Brings the tenants to the step the recorded transitions require now by
 * observing the server's sweep chain, then reports whether the deployment can
 * continue.
 */
export async function runDeploymentResume(
	reporter: Reporter,
	client: DeploymentClient,
	options: DeploymentResumeOptions
): Promise<void> {
	const { requiredLocalStep } = await client.transitions();
	const status = await settleTenants(client.localStep, reporter, {
		requiredStep: requiredLocalStep,
		limit: options.limit,
		...(options.signal !== undefined && { signal: options.signal }),
		...(options.delay !== undefined && { delay: options.delay })
	});
	reporter.result({
		kind: 'deployment-readiness',
		data: status,
		rows: [
			{ label: 'Ready tenants', value: String(status.ready) },
			{ label: 'Local step', value: String(status.required) }
		]
	});
	reporter.info(
		'Tenant work is complete for this transition. Re-run cupboard deploy to finish the deployment.'
	);
}

export function registerDeploymentCommands(
	program: Command,
	options: ProgramOptions = {}
): void {
	const deployment = program
		.command('deployment')
		.description('Inspect and resume tenant migration work.');
	const client = (url: URL): DeploymentClient => {
		const rpc = controlRpc(url, {
			credential: cachedOwnerProvider(url, { signal: options.signal }),
			signal: options.signal
		});

		return {
			transitions: () => rpc.deployment.transitions(),
			localStep: rpc.localStep
		};
	};
	deployment
		.command('status')
		.description('Show the schema transitions and pending tenant work.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			await runDeploymentStatus(
				commandUi(program, options).reporter(),
				client(url)
			);
		});
	deployment
		.command('resume')
		.description(
			'Wake the pending tenants and observe the sweep chain until they have reached the required local step, then report whether deployment can continue.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.option(
			'--limit <number>',
			'tenants attempted in the first batch (1–100)',
			parseBatchLimit,
			20
		)
		.action(async (url: URL, request: ResumeOptions) => {
			await runDeploymentResume(
				commandUi(program, options).reporter(),
				client(url),
				{
					limit: request.limit,
					...(options.signal !== undefined && { signal: options.signal })
				}
			);
		});
}
