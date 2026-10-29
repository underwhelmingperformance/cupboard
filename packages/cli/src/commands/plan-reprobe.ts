import { formatCount, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import type { DestinationProbes } from '../plan/availability-partition.ts';
import {
	type AvailabilityReprobe,
	reprobeAvailability
} from '../plan/availability-reprobe.ts';
import type { CohortTarget } from '../plan/cohort-target.ts';
import { parseReadUser } from '../read-user.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import {
	type PlanProbeOptions,
	planProbes,
	readCohortTargets
} from './plan-cohort.ts';

export interface PlanReprobeOptions extends PlanProbeOptions {
	readonly targetsFile: string;
}

export interface PlanReprobeRunOptions {
	readonly targets: readonly CohortTarget[];
}

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
			'Automation helper for the flake publish workflow. Just before the build starts, check which planned targets still need to be built.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[cache]', 'cache name, if the URL is a tenant URL')
		.requiredOption(
			'--targets-file <path>',
			'JSON file that describes the targets to be built'
		)
		.option(
			'--reference-source <url>',
			'cache URL to query for publication by reference',
			parseWorkerUrl
		)
		.option(
			'--reuse-view <name>',
			'reuse view to query for store paths that other caches already have'
		)
		.option(
			'--read-user <user>',
			'user name of the read credential for a private cache (default: $CUPBOARD_READ_USER)',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'password of the read credential for a private cache (default: $CUPBOARD_READ_PASSWORD)'
		)
		.option(
			'--view-read-user <user>',
			'user name of the read credential for a private reuse view (default: $CUPBOARD_VIEW_READ_USER)',
			parseReadUser
		)
		.option(
			'--view-read-password <password>',
			'password of the read credential for a private reuse view (default: $CUPBOARD_VIEW_READ_PASSWORD)'
		)
		.action(
			async (
				url: URL,
				cacheName: string | undefined,
				options: PlanReprobeOptions
			) => {
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					cacheName === undefined
						? urlTarget
						: cacheTargetWithName(urlTarget, cacheName);
				const destinationProbes = planProbes(target, options);
				const reporter = commandUi(program, programOptions).reporter();
				const targets = await readCohortTargets(options.targetsFile);

				await runPlanReprobe({ targets }, reporter, { destinationProbes });
			}
		);
}

/**
Queries the destination and reuse view again, then reports paths that became
available after the initial partition. It does not update retention, repeat
upstream confirmation, apply the unknown-path ceiling, or repartition the
plan. If no target became available, it reports the original build set.
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

			context.fact('withdrawn', formatCount(answer.withdrawn.length), {
				humanLabel: 'Now available in the cache'
			});
			context.fact('still to build', formatCount(answer.buildSet.length));
			context.result({
				kind: planReprobeResultKind,
				title: 'Build plan refresh',
				data: answer,
				rows: [
					{
						label: 'Now available in the cache',
						value: String(answer.withdrawn.length)
					},
					{ label: 'To build', value: String(answer.buildSet.length) }
				]
			});

			return answer;
		}
	);

	return reprobe;
}
