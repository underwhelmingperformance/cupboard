import { formatCount, type Reporter } from '@cupboard/reporter';
import type { ReadUser } from '@cupboard/shared/http';
import type { Command } from 'commander';

import { commandUi, type ProgramOptions } from '../cli.ts';
import { storedCacheFor } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import type { DestinationProbes } from '../plan/availability-partition.ts';
import {
	type AvailabilityReprobe,
	reprobeAvailability
} from '../plan/availability-reprobe.ts';
import type { ParsedCohortTarget } from '../plan/cohort-target.ts';
import { tenantProbesFor } from '../plan/destination-probe.ts';
import { parseReadUser } from '../read-user.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { readCohortTargets, readCredentials } from './plan-cohort.ts';

export interface PlanReprobeOptions {
	readonly targetsFile: string;
	readonly cache?: string;
	readonly reuseView?: string;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
}

export interface PlanReprobeRunOptions {
	/**
	The current build set, with one entry for each target Nix will realise.
	*/
	readonly targets: readonly ParsedCohortTarget[];
}

/**
 * The destination probes for the same tenant and cache used by the initial
 * partition. Tests can inject these dependencies.
 */
export interface PlanReprobeDependencies {
	readonly destinationProbes: DestinationProbes;
}

const planReprobeResultKind = 'plan-reprobe';

export function registerPlanReprobeCommand(
	plan: Command,
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	plan
		.command('reprobe')
		.description(
			'Confirm a build set still needs realising, immediately before it is built.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption(
			'--targets-file <path>',
			"JSON file describing the build set's targets"
		)
		.option('--cache <name>', 'target a named cache rather than the default')
		.option(
			'--reuse-view <name>',
			'named tenant reuse view to probe for substitutable paths'
		)
		.option(
			'--read-user <user>',
			'username for private cache reads',
			parseReadUser
		)
		.option('--read-password <password>', 'password for private cache reads')
		.action(async (url: URL, options: PlanReprobeOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const targets = await readCohortTargets(options.targetsFile);
			const credentials = readCredentials(options);

			await runPlanReprobe({ targets }, reporter, {
				destinationProbes: tenantProbesFor({
					baseUrl: url,
					cache: storedCacheFor(options.cache),
					...(options.reuseView !== undefined && { view: options.reuseView }),
					...(credentials !== undefined && { credentials })
				})
			});
		});
}

/**
 * Queries a planned build set again and reports paths that became available
 * after the initial partition. It only confirms availability; it does not
 * update retention, apply the unknown-path ceiling, or repartition the plan. If
 * no target became available, it reports the original build set unchanged.
 */
export async function runPlanReprobe(
	options: PlanReprobeRunOptions,
	reporter: Reporter,
	dependencies: PlanReprobeDependencies
): Promise<AvailabilityReprobe> {
	const reprobe = await reporter.phase(
		'Confirming the build set',
		async (context) => {
			const answer = await reprobeAvailability({
				targets: options.targets.map((target) => ({
					attr: target.attr,
					installable: target.installable,
					...(target.expectedPath !== undefined && {
						expectedPath: target.expectedPath
					}),
					root: target.root
				})),
				destinationProbes: dependencies.destinationProbes
			});

			context.fact('withdrawn', formatCount(answer.withdrawn.length));
			context.fact('still to build', formatCount(answer.buildSet.length));

			return answer;
		}
	);

	reporter.result({
		kind: planReprobeResultKind,
		data: reprobe,
		rows: [
			{ label: 'Withdrawn', value: String(reprobe.withdrawn.length) },
			{ label: 'To build', value: String(reprobe.buildSet.length) }
		]
	});

	return reprobe;
}
