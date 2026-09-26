import {
	hasReachedTransitionState,
	localStepWakeBodySchema,
	type ParsedDeploymentTransitionsResponse,
	schemaTransitions,
	type UnrecognisedDeploymentTransition
} from '@cupboard/protocol/deployment';
import { formatTimestamp, type Reporter } from '@cupboard/reporter';
import { type Command, InvalidArgumentError } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { readStoredTransition } from '../deploy/deployment-state.ts';
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
	readonly maxPasses: number;
}

export interface DeploymentClient {
	transitions(): Promise<ParsedDeploymentTransitionsResponse>;
	readonly localStep: SettlementClient;
}

export interface DeploymentResumeOptions {
	readonly limit: number;
	readonly maxPasses: number;
	readonly signal?: AbortSignal;
}

const transitionIds = schemaTransitions.map((transition) => transition.id);

// What this build's `cupboard deploy` does with a row that the server lists
// under `unrecognised`.
function unrecognisedRowText(row: UnrecognisedDeploymentTransition): string {
	const since = `${row.state} since ${formatTimestamp(row.updatedAt)}`;
	const reading = readStoredTransition(transitionIds, row);

	if (reading.kind === 'unrecognised') {
		return `${since}; this build does not define this transition, and no contract migration of it has started, so cupboard deploy leaves it unchanged`;
	}

	if (reading.kind === 'refused' && reading.reason === 'contracted') {
		return `${since}; this build does not define this transition, and cupboard deploy stops because its contract migrations have started and may have removed schema that this build needs`;
	}

	return `${since}, which this build does not define; deploy a build that defines this transition and state`;
}

function unrecognisedRows(
	unrecognised: readonly UnrecognisedDeploymentTransition[]
): { label: string; value: string }[] {
	return unrecognised.map((row) => ({
		label: `Transition ${row.id}`,
		value: unrecognisedRowText(row)
	}));
}

/**
 * Shows each recorded schema transition, any recorded row that this build does
 * not define, the required local step, and how many tenants have reached it.
 * The step comes from the same response as the counts, so the two always
 * agree.
 */
export async function runDeploymentStatus(
	reporter: Reporter,
	client: DeploymentClient
): Promise<void> {
	const { transitions, unrecognised } = await client.transitions();
	const status = await client.localStep.status({});
	const transitionRows =
		transitions.length === 0 && unrecognised.length === 0
			? [{ label: 'Transitions', value: 'none recorded' }]
			: transitions.map((transition) => ({
					label: `Transition ${transition.id}`,
					value: `${transition.state} since ${formatTimestamp(transition.updatedAt)}`
				}));
	reporter.result({
		kind: 'deployment-status',
		data: { transitions, unrecognised, ...status },
		rows: [
			...transitionRows,
			...unrecognisedRows(unrecognised),
			{ label: 'Required local step', value: String(status.required) },
			{ label: 'Ready tenants', value: String(status.ready) },
			{ label: 'Pending tenants', value: String(status.pending) },
			{
				label: 'Pending sample',
				value: status.stragglers.join(', ') || '(none)'
			}
		]
	});
}

/**
 * Wakes bounded batches of tenants until each has recorded the required local
 * step, then reports whether a schema transition is still incomplete and needs
 * another `cupboard deploy`. A recorded row that this build does not define is
 * listed with what this build's deploy does with it, and is left out of the
 * transitions to complete.
 */
export async function runDeploymentResume(
	reporter: Reporter,
	client: DeploymentClient,
	options: DeploymentResumeOptions
): Promise<void> {
	const status = await settleTenants(client.localStep, reporter, {
		limit: options.limit,
		maxPasses: options.maxPasses,
		...(options.signal !== undefined && { signal: options.signal })
	});
	const { transitions, unrecognised } = await client.transitions();
	reporter.result({
		kind: 'deployment-readiness',
		data: status,
		rows: [
			{ label: 'Ready tenants', value: String(status.ready) },
			{ label: 'Required local step', value: String(status.required) },
			...unrecognisedRows(unrecognised)
		]
	});
	const recorded = new Map(
		transitions.map((transition) => [transition.id, transition.state])
	);
	const refused = unrecognised
		.filter(
			(row) => readStoredTransition(transitionIds, row).kind === 'refused'
		)
		.map((row) => row.id);
	const incomplete = transitionIds.filter(
		(id) =>
			!hasReachedTransitionState(recorded.get(id), 'complete') &&
			!refused.includes(id)
	);
	const reached = `Every active or suspended tenant has reached local step ${String(status.required)}.`;

	if (refused.length > 0) {
		reporter.info(
			`${reached} This build's cupboard deploy stops on ${refused.join(', ')}, as listed above.`
		);
		return;
	}

	reporter.info(
		incomplete.length === 0
			? `Every active or suspended tenant has reached local step ${String(status.required)}, and every schema transition is complete.`
			: `${reached} Re-run cupboard deploy to complete ${incomplete.join(', ')}.`
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
			'Advance bounded tenant batches, then report whether deployment can continue.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.option(
			'--limit <number>',
			'tenants attempted per batch (1–100)',
			parseBatchLimit,
			20
		)
		.option(
			'--max-passes <number>',
			'maximum batches in this command (1–100)',
			parseBatchLimit,
			20
		)
		.action(async (url: URL, request: ResumeOptions) => {
			await runDeploymentResume(
				commandUi(program, options).reporter(),
				client(url),
				{
					limit: request.limit,
					maxPasses: request.maxPasses,
					...(options.signal !== undefined && { signal: options.signal })
				}
			);
		});
}
