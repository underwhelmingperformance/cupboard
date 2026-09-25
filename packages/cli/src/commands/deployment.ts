import {
	currentLocalStep,
	expansionLocalStep,
	localStepWakeBodySchema
} from '@cupboard/protocol/deployment';
import { type Command, InvalidArgumentError } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { settleTenants } from '../deploy/settlement.ts';
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

export function registerDeploymentCommands(
	program: Command,
	options: ProgramOptions = {}
): void {
	const deployment = program
		.command('deployment')
		.description('Check and continue the tenant migrations of an upgrade.');
	const client = (url: URL) =>
		controlRpc(url, {
			credential: cachedOwnerProvider(url, { signal: options.signal }),
			signal: options.signal
		});
	deployment
		.command('status')
		.description(
			"Show the deployment's upgrade phase and how many tenants are still migrating."
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const rpc = client(url);
			const phase = await rpc.deployment.phase();
			const requiredStep =
				phase.phase?.name === 'contracted'
					? currentLocalStep
					: expansionLocalStep;
			const status = await rpc.localStep.status({ requiredStep });
			commandUi(program, options)
				.reporter()
				.result({
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
		});
	deployment
		.command('resume')
		.description(
			'Wake the tenants that are still migrating, in batches, and report whether ' +
				'the deploy can finish.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.option(
			'--limit <number>',
			'number of tenants to wake in each batch (1–100)',
			parseBatchLimit,
			20
		)
		.option(
			'--max-passes <number>',
			'maximum number of batches to run (1–100)',
			parseBatchLimit,
			20
		)
		.action(async (url: URL, request: ResumeOptions) => {
			const rpc = client(url);
			const phase = await rpc.deployment.phase();
			const reporter = commandUi(program, options).reporter();
			const status = await settleTenants(rpc.localStep, reporter, {
				requiredStep:
					phase.phase?.name === 'contracted'
						? currentLocalStep
						: expansionLocalStep,
				limit: request.limit,
				maxPasses: request.maxPasses,
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
		});
}
