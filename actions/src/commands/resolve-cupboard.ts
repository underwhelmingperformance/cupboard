import { env } from 'node:process';

import type { Command } from 'commander';

import {
	resolveCupboard,
	type ResolveCupboardOptions,
	serialiseResolvedCupboard
} from '../cupboard-resolution.ts';
import { type Environment, setOutput } from '../inputs.ts';
import { provided } from '../options.ts';

export interface ResolveCupboardCommandOptions {
	readonly cupboardVersion?: string;
	readonly workflowRepository?: string;
	readonly workflowRef?: string;
	readonly workflowSha?: string;
	readonly githubToken?: string;
	readonly githubApiUrl?: string;
	readonly githubGraphqlUrl?: string;
}

interface ResolveCupboardCommandDependencies {
	readonly resolve: typeof resolveCupboard;
}

const defaultDependencies: ResolveCupboardCommandDependencies = {
	resolve: resolveCupboard
};

export function registerResolveCupboardCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('resolve-cupboard')
		.description(
			'Resolve a reusable workflow pin to one canonical cupboard acquisition.'
		)
		.option(
			'--cupboard-version <version>',
			"explicit release selector: 'latest' or an exact published tag"
		)
		.requiredOption(
			'--workflow-repository <repository>',
			'repository containing the called workflow'
		)
		.requiredOption(
			'--workflow-ref <reference>',
			'full job.workflow_ref of the called workflow'
		)
		.requiredOption(
			'--workflow-sha <commit>',
			'full job.workflow_sha of the called workflow'
		)
		.option('--github-token <token>', 'GitHub token used for API calls')
		.option('--github-api-url <url>', 'GitHub REST API base URL')
		.option('--github-graphql-url <url>', 'GitHub GraphQL API URL')
		.action((options: ResolveCupboardCommandOptions) =>
			resolveCupboardAction(options, environment)
		);
}

export async function resolveCupboardAction(
	options: ResolveCupboardCommandOptions,
	environment: Environment = env,
	dependencies: ResolveCupboardCommandDependencies = defaultDependencies
): Promise<void> {
	const resolved = await dependencies.resolve(resolveOptions(options));

	await setOutput(environment, 'cupboard', serialiseResolvedCupboard(resolved));
}

function resolveOptions(
	options: ResolveCupboardCommandOptions
): ResolveCupboardOptions {
	return {
		cupboardVersion: provided(options.cupboardVersion),
		includePrereleases: true,
		releaseRepository: options.workflowRepository ?? '',
		githubToken: options.githubToken ?? '',
		workflowSha: options.workflowSha ?? '',
		workflowRef: options.workflowRef ?? '',
		githubApiUrl: provided(options.githubApiUrl),
		githubGraphqlUrl: provided(options.githubGraphqlUrl)
	};
}
