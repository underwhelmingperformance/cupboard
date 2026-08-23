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
			'Resolve a reusable workflow revision to an exact release or source commit.'
		)
		.option(
			'--cupboard-version <version>',
			"use 'latest' or an exact published release tag instead of the workflow revision"
		)
		.requiredOption(
			'--workflow-repository <repository>',
			'repository for the called reusable workflow'
		)
		.requiredOption(
			'--workflow-ref <reference>',
			'full job.workflow_ref of the called workflow'
		)
		.requiredOption(
			'--workflow-sha <commit>',
			'full job.workflow_sha of the called workflow'
		)
		.option('--github-token <token>', 'GitHub token for release API calls')
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
