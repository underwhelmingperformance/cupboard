import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	localStepWakeBodySchema,
	type ParsedDeploymentPhaseResponse
} from '@cupboard/protocol/deployment';
import type { Reporter } from '@cupboard/reporter';
import { type Command, InvalidArgumentError } from 'commander';

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
	readonly maxPasses: number;
}

export interface DeploymentClient {
	phase(): Promise<ParsedDeploymentPhaseResponse>;
	readonly localStep: SettlementClient;
}

export interface DeploymentResumeOptions {
	readonly limit: number;
	readonly maxPasses: number;
	readonly signal?: AbortSignal;
}

function requiredStepFor(response: ParsedDeploymentPhaseResponse): LocalStep {
	return response.phase?.name === 'contracted'
		? currentLocalStep
		: expansionLocalStep;
}

/**
 * Shows the recorded deployment phase, the local step that the phase
 * requires, and how many tenants have reached that step.
 */
export async function runDeploymentStatus(
	reporter: Reporter,
	client: DeploymentClient
): Promise<void> {
	const phase = await client.phase();
	const requiredStep = requiredStepFor(phase);
	const status = await client.localStep.status({ requiredStep });
	reporter.result({
		kind: 'deployment-status',
		data: { ...phase, ...status },
		rows: [
			{ label: 'Phase', value: phase.phase?.name ?? 'not recorded' },
			{ label: 'Required local step', value: String(requiredStep) },
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
 * Wakes bounded batches of tenants until each has recorded the local step
 * that the recorded phase requires.
 */
export async function runDeploymentResume(
	reporter: Reporter,
	client: DeploymentClient,
	options: DeploymentResumeOptions
): Promise<void> {
	const phase = await client.phase();
	const status = await settleTenants(client.localStep, reporter, {
		requiredStep: requiredStepFor(phase),
		limit: options.limit,
		maxPasses: options.maxPasses,
		...(options.signal !== undefined && { signal: options.signal })
	});
	reporter.result({
		kind: 'deployment-readiness',
		data: status,
		rows: [
			{ label: 'Ready tenants', value: String(status.ready) },
			{ label: 'Local step', value: String(status.current) }
		]
	});
	reporter.info(
		'Tenant work is complete for this phase. Re-run cupboard deploy to finish the deployment.'
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
			phase: () => rpc.deployment.phase(),
			localStep: rpc.localStep
		};
	};
	deployment
		.command('status')
		.description('Show the deployment phase and pending tenant work.')
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
