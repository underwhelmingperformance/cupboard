import type { CliUi } from '@cupboard/cli-ui';
import type { CacheScope } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	buildInputsClearMaxPaths,
	type BuildInputsClearResponse,
	type BuildInputsClearResult,
	type BuildInputsReadResponse
} from '@cupboard/protocol/build-inputs';
import type { Reporter } from '@cupboard/reporter';
import { chunk } from '@cupboard/shared/collections';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { contentReadAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush, cachedOwnerProvider } from '../auth/auth.ts';
import { resolveAuthorisedCachePositionals } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { CupboardClient } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	CommandPayloadRequiredError,
	PathResponseMismatchError
} from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export interface BuildInputsAdminClient {
	readonly read: CacheScopedClient<{ hash: string }, BuildInputsReadResponse>;
	readonly clear: CacheScopedClient<
		{ storePathHashes: string[] },
		BuildInputsClearResponse
	>;
}

interface BuildInputsShowOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

interface BuildInputsClearOptions {
	readonly yes?: boolean;
}

export function registerBuildInputsCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const buildInputs = program
		.command('build-inputs')
		.description(
			'Show or clear the build inputs recorded for store paths in a cache.'
		);

	buildInputs
		.command('show')
		.description('Show the build inputs of one store path in a cache.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<arguments...>',
			'an optional cache name, then the store path to show'
		)
		.option(
			'--github-oidc',
			"sign in with the job's GitHub Actions OIDC token instead of your saved `cupboard login` session"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.action(
			async (
				url: URL,
				positionals: string[],
				options: BuildInputsShowOptions
			) => {
				const resolved = await resolveAuthorisedCachePositionals(
					url,
					positionals,
					{
						minimumPayload: 1,
						maximumPayload: 1,
						payloadDescription: 'a store path',
						parsePayloadEntry: (entry) => entry,
						authorise: (target) =>
							authenticateForPush(
								CupboardClient.fromUrl(target.tenantUrl, {
									cache: target.cache,
									signal: programOptions.signal
								}),
								{
									githubOidc: options.githubOidc,
									audience:
										options.audience ?? audienceSchema.parse(target.tenantUrl),
									authorizationDetails: contentReadAuthorizationDetails({
										cache: target.cache
									})
								}
							),
						signal: programOptions.signal
					}
				);
				const [storePath] = resolved.payload;

				if (storePath === undefined) {
					throw new CommandPayloadRequiredError('a store path');
				}

				const rpc = tenantRpc(resolved.target.tenantUrl, {
					credential: resolved.credential,
					signal: programOptions.signal
				});

				await runBuildInputsShow(
					resolved.target.cache,
					storePath,
					commandUi(program, programOptions).reporter(),
					rpc.buildInputs
				);
			}
		);

	buildInputs
		.command('clear')
		.description(
			'Clear the build inputs of store paths in a cache, so that garbage collection no longer keeps those build inputs for them.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<arguments...>',
			'an optional cache name, then the store paths to clear'
		)
		.option('-y, --yes', 'clear without the confirmation prompt')
		.action(
			async (
				url: URL,
				positionals: string[],
				options: BuildInputsClearOptions
			) => {
				const resolved = await resolveAuthorisedCachePositionals(
					url,
					positionals,
					{
						minimumPayload: 1,
						payloadDescription: 'a store path',
						parsePayloadEntry: (entry) => entry,
						authorise: (target) =>
							cachedOwnerProvider(target.tenantUrl, {
								signal: programOptions.signal
							}),
						signal: programOptions.signal
					}
				);
				const rpc = tenantRpc(resolved.target.tenantUrl, {
					credential: resolved.credential,
					signal: programOptions.signal
				});

				await runBuildInputsClear(
					resolved.target.cache,
					resolved.payload,
					commandUi(program, programOptions, { assumeYes: options.yes }),
					rpc.buildInputs
				);
			}
		);
}

export async function runBuildInputsShow(
	cache: CacheScope,
	storePath: string,
	reporter: Reporter,
	client: Pick<BuildInputsAdminClient, 'read'>
): Promise<void> {
	const hash = StorePath.hash(storePath);
	const result = await reporter.phase('Reading build inputs', () =>
		callInCache(client.read, cache, { hash })
	);

	reporter.result({
		kind: 'build-inputs',
		title: 'Build inputs',
		data: result,
		rows: [
			{ label: 'Store path', value: StorePath.basename(storePath) },
			...(result.status === 'recorded'
				? [
						{ label: 'Version', value: String(result.buildInputsVersion) },
						...result.buildInputs.map((buildInput) => ({
							label: 'Build input',
							value: buildInput
						}))
					]
				: [{ label: 'Status', value: describeReadStatus(result.status) }])
		]
	});
}

function describeReadStatus(
	status: Exclude<BuildInputsReadResponse['status'], 'recorded'>
): string {
	switch (status) {
		case 'none': {
			return 'no build inputs recorded';
		}
		case 'absent': {
			return 'not in this cache';
		}
		case 'invalid-stored': {
			return 'the stored build inputs cannot be read; clear them';
		}
	}
}

export async function runBuildInputsClear(
	cache: CacheScope,
	storePaths: readonly string[],
	ui: CliUi,
	client: Pick<BuildInputsAdminClient, 'clear'>
): Promise<void> {
	const basenames = new Map(
		storePaths.map((storePath) => [
			StorePath.hash(storePath),
			StorePath.basename(storePath)
		])
	);
	const hashes = basenames.keys().toArray();
	const outcome = await ui.confirm({
		message: `Clear the build inputs of ${describeCount(hashes.length)}?`,
		detail:
			'Store paths kept only by these build inputs may be deleted by the next garbage collection.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('No build inputs were cleared.');
		return;
	}

	const reporter = ui.reporter();
	const results = await reporter.phase('Clearing build inputs', async () => {
		const cleared: BuildInputsClearResult[] = [];

		for (const page of chunk(hashes, buildInputsClearMaxPaths)) {
			const response = await callInCache(client.clear, cache, {
				storePathHashes: page
			});
			const mismatch = page.findIndex(
				(storePathHash, index) =>
					response.entries[index]?.storePathHash !== storePathHash
			);

			if (mismatch !== -1 || response.entries.length !== page.length) {
				throw new PathResponseMismatchError(
					'buildInputs.clear',
					page[mismatch === -1 ? page.length - 1 : mismatch] ?? ''
				);
			}

			cleared.push(...response.entries);
		}

		return cleared;
	});

	reporter.result({
		kind: 'build-inputs-clear',
		title: 'Cleared build inputs',
		data: results,
		rows: results.map((result) => ({
			label: basenames.get(result.storePathHash) ?? result.storePathHash,
			value: describeClearStatus(result.status)
		}))
	});
}

function describeClearStatus(status: BuildInputsClearResult['status']): string {
	switch (status) {
		case 'cleared': {
			return 'cleared';
		}
		case 'unchanged': {
			return 'no build inputs recorded';
		}
		case 'absent': {
			return 'not in this cache';
		}
	}
}

function describeCount(count: number): string {
	return `${String(count)} store ${count === 1 ? 'path' : 'paths'}`;
}
