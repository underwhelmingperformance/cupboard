import type { CliUi } from '@cupboard/cli-ui';
import {
	type RootName,
	selectorForCache,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import type { AuthorizationDetails } from '@cupboard/protocol/grants';
import type {
	ParsedRootEnsureResponse,
	ParsedRootListEntry,
	ParsedRootListResponse,
	ParsedRootRemoveResponse,
	ParsedRootSetResponse,
	ParsedRootTarget,
	ParsedRootTargetsPage
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
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient, storedCacheFor } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseTtl } from '../duration.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface RootSetOptions {
	readonly ttl?: TtlSeconds;
	readonly cache?: string;
}

interface RootEnsureOptions extends RootSetOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

interface RootOptions {
	readonly cache?: string;
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
	cacheSelector: string,
	root?: RootName
): AuthorizationDetails {
	return rootListAuthorizationDetails({
		cacheSelector,
		...(root !== undefined && { root })
	});
}

/**
 * The part of the derived client that the root commands use, in the contract's
 * input and output shapes. The real `tenantRpc(...).roots` satisfies this
 * interface by construction.
 */
export interface RootClient {
	set(input: {
		cacheName: string;
		name: string;
		targets: string[];
		ttlSeconds?: number;
	}): Promise<ParsedRootSetResponse>;
	ensure(input: {
		cacheName: string;
		name: string;
		targets: string[];
		ttlSeconds?: number;
	}): Promise<ParsedRootEnsureResponse>;
	list(input: {
		params: { cacheName: string };
		query?: { cursor?: string; limit?: number };
	}): Promise<ParsedRootListResponse>;
	targets(input: {
		params: { cacheName: string; name: string };
		query?: { cursor?: string; limit?: number };
	}): Promise<ParsedRootTargetsPage>;
	remove(input: {
		cacheName: string;
		name: string;
	}): Promise<ParsedRootRemoveResponse>;
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
			'Retain targets already present in the cache, or report that a build is required. ' +
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
		.option('--cache <name>', 'target a named cache rather than the default')
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
				const reporter = commandUi(program, programOptions).reporter();
				const cacheName = selectorForCache(storedCacheFor(options.cache));
				const credential = await authenticateForPush(
					CupboardClient.fromUrl(url, { signal: programOptions.signal }),
					{
						githubOidc: options.githubOidc,
						audience: options.audience ?? audienceSchema.parse(url),
						authorizationDetails: rootEnsureAuthorizationDetails({
							cacheSelector: cacheName,
							root: name
						})
					}
				);
				const rpc = tenantRpc(url, {
					credential,
					signal: programOptions.signal
				});

				await runRootEnsure(
					cacheName,
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
		.option('--cache <name>', 'target a named cache rather than the default')
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
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = tenantRpc(url, {
					credential: cachedOwnerProvider(url, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

				await runRootSet(
					selectorForCache(storedCacheFor(options.cache)),
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
		.option('--cache <name>', 'target a named cache rather than the default')
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.action(async (url: URL, options: RootListingOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const cacheName = selectorForCache(storedCacheFor(options.cache));
			const credential = await authenticateForPush(
				CupboardClient.fromUrl(url, { signal: programOptions.signal }),
				{
					githubOidc: options.githubOidc,
					audience: options.audience ?? audienceSchema.parse(url),
					authorizationDetails: rootListingAuthorizationDetails(cacheName)
				}
			);
			const rpc = tenantRpc(url, {
				credential,
				signal: programOptions.signal
			});

			await runRootList(cacheName, reporter, rpc.roots);
		});

	root
		.command('targets')
		.description("List a retention root's targets and whether each is served.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'root name, e.g. github:owner/repo/main', parseRootName)
		.option('--cache <name>', 'target a named cache rather than the default')
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
			const reporter = commandUi(program, programOptions).reporter();
			const cacheName = selectorForCache(storedCacheFor(options.cache));
			const credential = await authenticateForPush(
				CupboardClient.fromUrl(url, { signal: programOptions.signal }),
				{
					githubOidc: options.githubOidc,
					audience: options.audience ?? audienceSchema.parse(url),
					authorizationDetails: rootListingAuthorizationDetails(cacheName, name)
				}
			);
			const rpc = tenantRpc(url, {
				credential,
				signal: programOptions.signal
			});

			await runRootTargets(cacheName, name, reporter, rpc.roots);
		});

	root
		.command('remove')
		.description('Remove a retention root.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'root name to remove', parseRootName)
		.option('--cache <name>', 'target a named cache rather than the default')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: URL, name: RootName, options: RootOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runRootRemove(
				selectorForCache(storedCacheFor(options.cache)),
				name,
				ui,
				rpc.roots
			);
		});
}

export async function runRootEnsure(
	cacheName: string,
	name: RootName,
	targets: readonly string[],
	ttlSeconds: TtlSeconds | undefined,
	reporter: Reporter,
	client: Pick<RootClient, 'ensure'>
): Promise<void> {
	const result = await reporter.phase('Checking retention root', () =>
		client.ensure({
			cacheName,
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
	cacheName: string,
	name: RootName,
	targets: readonly string[],
	ttlSeconds: TtlSeconds | undefined,
	reporter: Reporter,
	client: Pick<RootClient, 'set'>
): Promise<void> {
	const summary = await reporter.phase('Setting retention root', () =>
		client.set({
			cacheName,
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
	cacheName: string,
	reporter: Reporter,
	client: Pick<RootClient, 'list'>
): Promise<void> {
	const roots = await reporter.phase('Listing retention roots', async () => {
		const entries: ParsedRootListEntry[] = [];
		let cursor: string | undefined;

		do {
			const page = await client.list({
				params: { cacheName },
				...(cursor !== undefined && { query: { cursor } })
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
	cacheName: string,
	name: RootName,
	reporter: Reporter,
	client: Pick<RootClient, 'targets'>
): Promise<void> {
	// A run root can accumulate attached paths without bound, so the targets are
	// read page by page.
	const targets = await reporter.phase('Listing root targets', async () => {
		const collected: ParsedRootTarget[] = [];
		let cursor: string | undefined;

		do {
			const page = await client.targets({
				params: { cacheName, name },
				...(cursor !== undefined && { query: { cursor } })
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
	cacheName: string,
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
		client.remove({ cacheName, name })
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

function rootListRow(root: ParsedRootListEntry): ResultRow {
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
