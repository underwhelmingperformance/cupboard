import type { CliUi } from '@cupboard/cli-ui';
import {
	type CacheScope,
	type RootName,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import type { AuthorizationDetails } from '@cupboard/protocol/grants';
import type {
	RootEnsureResponse,
	RootListEntry,
	RootListResponse,
	RootRemoveResponse,
	RootSetResponse,
	RootTarget,
	RootTargetsPage
} from '@cupboard/protocol/retention';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import {
	rootEnsureAuthorizationDetails,
	rootListAuthorizationDetails
} from '../auth/attenuate.ts';
import { authenticateForPush, cachedOwnerProvider } from '../auth/auth.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { CupboardClient } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseTtl } from '../duration.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface RootSetOptions {
	readonly ttl?: TtlSeconds;
}

interface RootEnsureOptions extends RootSetOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

interface RootOptions {
	readonly yes?: boolean;
}

interface RootListingOptions extends RootOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

/**
 * The authority requested by a listing command's token exchange: cache-wide for
 * `root list`, and narrowed to the single root that `root targets` reads.
 * Exported so a test can check the grant a CI read requests without running the
 * command.
 */
export function rootListingAuthorizationDetails(
	cache: CacheScope,
	root?: RootName
): AuthorizationDetails {
	return rootListAuthorizationDetails({
		cache,
		...(root !== undefined && { root })
	});
}

/**
 * The part of the derived client that the root commands use, in the contract's
 * input and output shapes. The real `tenantRpc(...).roots` satisfies this
 * interface by construction.
 */
export interface RootClient {
	set: CacheScopedClient<
		{
			name: string;
			targets: string[];
			ttlSeconds?: number;
		},
		RootSetResponse
	>;
	ensure: CacheScopedClient<
		{
			name: string;
			targets: string[];
			ttlSeconds?: number;
		},
		RootEnsureResponse
	>;
	list: CacheScopedClient<
		{
			cursor?: string;
			limit?: number;
		},
		RootListResponse
	>;
	targets: CacheScopedClient<
		{
			name: string;
			cursor?: string;
			limit?: number;
		},
		RootTargetsPage
	>;
	remove: CacheScopedClient<
		{
			name: string;
		},
		RootRemoveResponse
	>;
}

export function registerRootCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const root = program
		.command('root')
		.description('Manage retention roots: named sets of store paths to keep.');

	root
		.command('ensure')
		.description(
			'Retain targets the cache can serve, or report that a build is required. ' +
				'Both outcomes exit 0; the reported status is either retained or build required.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'root name, e.g. github:owner/repo/main', parseRootName)
		.argument('<store-path...>', 'one or more top-level store paths to retain')
		.option(
			'--ttl <duration>',
			'expire the root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.action(
			async (
				url: URL,
				name: RootName,
				targets: string[],
				options: RootEnsureOptions
			) => {
				const target = cacheTargetFromUrl(url);
				const reporter = commandUi(program, programOptions).reporter();
				const credential = await authenticateForPush(
					CupboardClient.fromUrl(target.tenantUrl, {
						cache: target.cache,
						signal: programOptions.signal
					}),
					{
						githubOidc: options.githubOidc,
						audience:
							options.audience ?? audienceSchema.parse(target.tenantUrl),
						authorizationDetails: rootEnsureAuthorizationDetails({
							cache: target.cache,
							root: name
						})
					}
				);
				const rpc = tenantRpc(target.tenantUrl, {
					credential,
					signal: programOptions.signal
				});

				await runRootEnsure(
					target.cache,
					name,
					targets,
					options.ttl,
					reporter,
					rpc.roots
				);
			}
		);

	root
		.command('set')
		.description('Create or replace a retention root with the given targets.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'root name, e.g. github:owner/repo/main', parseRootName)
		.argument('<store-path...>', 'one or more top-level store paths to retain')
		.option(
			'--ttl <duration>',
			'expire the root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				"  # Keep a branch's top-level paths, expiring after 30 days",
				'  cupboard root set https://cupboard.example.workers.dev/t/acme \\',
				'    github:acme/infra/main /nix/store/<hash>-app --ttl 30d'
			].join('\n')
		)
		.action(
			async (
				url: URL,
				name: RootName,
				targets: string[],
				options: RootSetOptions
			) => {
				const target = cacheTargetFromUrl(url);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = tenantRpc(target.tenantUrl, {
					credential: cachedOwnerProvider(target.tenantUrl, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

				await runRootSet(
					target.cache,
					name,
					targets,
					options.ttl,
					reporter,
					rpc.roots
				);
			}
		);

	root
		.command('list')
		.description('List retention roots.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[cache]', 'named cache when the URL does not select one')
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.action(
			async (
				url: URL,
				cacheName: string | undefined,
				options: RootListingOptions
			) => {
				const reporter = commandUi(program, programOptions).reporter();
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					cacheName === undefined
						? urlTarget
						: cacheTargetWithName(urlTarget, cacheName);
				const credential = await authenticateForPush(
					CupboardClient.fromUrl(target.tenantUrl, {
						cache: target.cache,
						signal: programOptions.signal
					}),
					{
						githubOidc: options.githubOidc,
						audience:
							options.audience ?? audienceSchema.parse(target.tenantUrl),
						authorizationDetails: rootListingAuthorizationDetails(target.cache)
					}
				);
				const rpc = tenantRpc(target.tenantUrl, {
					credential,
					signal: programOptions.signal
				});

				await runRootList(target.cache, reporter, rpc.roots);
			}
		);

	root
		.command('targets')
		.description("List a retention root's targets and whether each is served.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'root name, e.g. github:owner/repo/main', parseRootName)
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.action(async (url: URL, name: RootName, options: RootListingOptions) => {
			const target = cacheTargetFromUrl(url);
			const reporter = commandUi(program, programOptions).reporter();
			const credential = await authenticateForPush(
				CupboardClient.fromUrl(target.tenantUrl, {
					cache: target.cache,
					signal: programOptions.signal
				}),
				{
					githubOidc: options.githubOidc,
					audience: options.audience ?? audienceSchema.parse(target.tenantUrl),
					authorizationDetails: rootListingAuthorizationDetails(
						target.cache,
						name
					)
				}
			);
			const rpc = tenantRpc(target.tenantUrl, {
				credential,
				signal: programOptions.signal
			});

			await runRootTargets(target.cache, name, reporter, rpc.roots);
		});

	root
		.command('remove')
		.description('Remove a retention root.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'root name to remove', parseRootName)
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: URL, name: RootName, options: RootOptions) => {
			const target = cacheTargetFromUrl(url);
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(target.tenantUrl, {
				credential: cachedOwnerProvider(target.tenantUrl, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal
			});

			await runRootRemove(target.cache, name, ui, rpc.roots);
		});
}

export async function runRootEnsure(
	cache: CacheScope,
	name: RootName,
	targets: readonly string[],
	ttlSeconds: TtlSeconds | undefined,
	reporter: Reporter,
	client: Pick<RootClient, 'ensure'>
): Promise<void> {
	const result = await reporter.phase('Checking retention root', () =>
		callInCache(client.ensure, cache, {
			name,
			targets: [...targets],
			...(ttlSeconds !== undefined && { ttlSeconds })
		})
	);

	reporter.result({
		kind: 'root-ensure',
		data: result,
		rows:
			result.status === 'retained'
				? [
						{ label: 'Root', value: result.root.name },
						{ label: 'Status', value: 'retained' },
						{ label: 'Expiry', value: describeExpiry(result.root) }
					]
				: [
						{ label: 'Root', value: name },
						{ label: 'Status', value: 'build required' },
						...result.unavailable.map((storePath) => ({
							label: 'Unavailable',
							value: storePath
						}))
					]
	});
}

export async function runRootSet(
	cache: CacheScope,
	name: RootName,
	targets: readonly string[],
	ttlSeconds: TtlSeconds | undefined,
	reporter: Reporter,
	client: Pick<RootClient, 'set'>
): Promise<void> {
	const summary = await reporter.phase('Setting retention root', () =>
		callInCache(client.set, cache, {
			name,
			targets: [...targets],
			...(ttlSeconds !== undefined && { ttlSeconds })
		})
	);

	reporter.result({
		kind: 'root',
		data: summary,
		rows: [
			{ label: 'Root', value: summary.name },
			{ label: 'Targets', value: String(summary.targets.length) },
			{ label: 'Expiry', value: describeExpiry(summary) }
		]
	});
}

export async function runRootList(
	cache: CacheScope,
	reporter: Reporter,
	client: Pick<RootClient, 'list'>
): Promise<void> {
	const roots = await reporter.phase('Listing retention roots', async () => {
		const entries: RootListEntry[] = [];
		let cursor: string | undefined;

		do {
			const page = await callInCache(client.list, cache, {
				...(cursor !== undefined && { cursor })
			});

			entries.push(...page.roots);
			cursor = page.cursor;
		} while (cursor !== undefined);

		return entries;
	});

	reporter.result({
		kind: 'roots',
		data: roots,
		rows: roots.map((root) => rootListRow(root)),
		empty: 'No retention roots.'
	});
}

export async function runRootTargets(
	cache: CacheScope,
	name: RootName,
	reporter: Reporter,
	client: Pick<RootClient, 'targets'>
): Promise<void> {
	// A run root can accumulate attached paths without bound, so the targets are
	// read page by page.
	const targets = await reporter.phase('Listing root targets', async () => {
		const collected: RootTarget[] = [];
		let cursor: string | undefined;

		do {
			const page = await callInCache(client.targets, cache, {
				name,
				...(cursor !== undefined && { cursor })
			});

			collected.push(...page.targets);
			cursor = page.cursor;
		} while (cursor !== undefined);

		return collected;
	});

	reporter.result({
		kind: 'root-targets',
		data: targets,
		rows: targets.map((target) => ({
			label: target.storePath,
			value: target.present ? 'present' : 'missing'
		})),
		empty: 'No targets.'
	});
}

export async function runRootRemove(
	cache: CacheScope,
	name: RootName,
	ui: CliUi,
	client: RootClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove retention root ${name}?`,
		detail: 'Paths kept only by this root become eligible for collection.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The retention root was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Removing retention root', () =>
		callInCache(client.remove, cache, { name })
	);

	reporter.result({
		kind: 'root',
		data: result,
		rows: [
			{ label: 'Root', value: result.name },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
		]
	});
}

function rootListRow(root: RootListEntry): ResultRow {
	return {
		label: root.name,
		value: `${String(root.targetCount)} target(s); ${describeExpiry(root)}`
	};
}

export function describeExpiry(summary: {
	readonly expiresAt?: string;
	readonly expired: boolean;
}): string {
	if (summary.expiresAt === undefined) {
		return 'permanent';
	}

	if (summary.expired) {
		return `expired (${formatTimestamp(summary.expiresAt)})`;
	}

	return `expires ${formatTimestamp(summary.expiresAt)}`;
}
