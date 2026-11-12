import { readFile } from 'node:fs/promises';

import type { CliUi } from '@cupboard/cli-ui';
import {
	type CacheScope,
	type RootName,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { tenantContract } from '@cupboard/protocol/contract';
import type { AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	type RetainedRoot,
	retainedRoots
} from '@cupboard/protocol/publish-plan';
import type {
	RootBatchBody,
	RootBatchResponse,
	RootBatchResult,
	RootEnsureBodyInput,
	RootEnsureResponse,
	RootListEntry,
	RootListResponse,
	RootRemoveResponse,
	RootRetentionRequest,
	RootSetBodyInput,
	RootSetResponse,
	RootTarget,
	RootTargetsPage
} from '@cupboard/protocol/retention';
import {
	rootRemoveLeftoverTargetsCapability,
	rootSetMaxTargets
} from '@cupboard/protocol/retention';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { collectProgressively } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { cursorPages } from '@cupboard/shared/paging';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import {
	rootEnsureAuthorizationDetails,
	rootListAuthorizationDetails,
	rootSetAuthorizationDetails
} from '../auth/attenuate.ts';
import { authenticateForPush, cachedOwnerProvider } from '../auth/auth.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { acceptingCapability } from '../client/accepted-capability.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { CupboardClient } from '../client/client.ts';
import { listingLimits } from '../client/listings.ts';
import { procedureDeadline, tenantRpc } from '../client/orpc.ts';
import {
	applyRootBatches,
	type RootBatchEntry,
	rootBatches,
	RootTargetLimitError,
	separateRootRequestConcurrency
} from '../client/root-batches.ts';
import { isRpcProcedureMissingError } from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseTtl } from '../duration.ts';
import { CliUsageError } from '../errors.ts';
import { parsePublishPlan } from '../plan/publish-plan-file.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { rootRetentionChoice } from './retention-choice.ts';

interface RootSetOptions {
	readonly ttl?: TtlSeconds;
	readonly permanent?: boolean;
}

interface RootEnsureOptions extends RootSetOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly plan?: string;
}

/**
`root ensure` takes either a root name with its store paths, or `--plan`.
*/
export class RootEnsureArgumentsError extends CliUsageError {
	constructor(readonly reason: 'plan-with-root' | 'root-required') {
		super(
			reason === 'plan-with-root'
				? '--plan cannot be combined with a root name or store paths'
				: 'give a root name and at least one store path, or --plan'
		);
		this.name = 'RootEnsureArgumentsError';
	}
}

interface RootOptions {
	readonly yes?: boolean;
}

interface RootListingOptions extends RootOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

/**
The authority requested by a listing command's token exchange: cache-wide for
`root list`, and narrowed to the single root that `root targets` reads.
Exported so a test can check the grant a CI read requests without running the
command.
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
The part of the derived client that the root commands use, in the contract's
input and output shapes. The real `tenantRpc(...).roots` satisfies this
interface by construction.
*/
export interface RootClient {
	set: CacheScopedClient<
		RootSetBodyInput & { readonly name: string },
		RootSetResponse
	>;
	ensure: CacheScopedClient<
		RootEnsureBodyInput & { readonly name: string },
		RootEnsureResponse
	>;
	batch: CacheScopedClient<RootBatchBody, RootBatchResponse>;
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
		.description(
			'Manage retention roots, which keep named sets of store paths in a cache.'
		);
	const ensurePlanRoots = async (
		url: URL,
		planFile: string,
		options: RootEnsureOptions
	): Promise<void> => {
		const roots = retainedRoots(
			parsePublishPlan(await readFile(planFile, 'utf8'))
		);
		const retention = rootRetentionChoice(options.ttl, options.permanent);
		// Refuse an oversized root before the token exchange.
		rootBatches(ensureEntries(roots, retention));
		const target = cacheTargetFromUrl(url);
		const reporter = commandUi(program, programOptions).reporter();

		// A token exchange must request at least one grant.
		if (roots.length === 0) {
			reportRootEnsures(reporter, []);
			return;
		}

		const credential = await authenticateForPush(
			CupboardClient.fromUrl(target.tenantUrl, {
				cache: target.cache,
				signal: programOptions.signal
			}),
			{
				githubOidc: options.githubOidc,
				audience: options.audience ?? audienceSchema.parse(target.tenantUrl),
				authorizationDetails: rootSetAuthorizationDetails({
					cache: target.cache,
					roots: roots.map((entry) => entry.name)
				})
			}
		);
		const rpc = tenantRpc(target.tenantUrl, {
			credential,
			signal: programOptions.signal
		});

		await runRootEnsurePlan(
			target.cache,
			roots,
			retention,
			reporter,
			rpc.roots
		);
	};

	root
		.command('ensure')
		.description(
			'Set a root only if the cache can serve every store path. Otherwise, ' +
				'list the missing store paths and change nothing.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'root name (e.g. github:acme/app/main)', parseRootName)
		.argument('[store-path...]', 'the store paths for the root to keep')
		.option(
			'--plan <file>',
			"ensure the root of every retained target in this publish plan, which the publish workflow's plan step writes, instead of one named root"
		)
		.option(
			'--ttl <duration>',
			'expire the root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--permanent', 'keep the root permanently')
		.addHelpText(
			'after',
			[
				'',
				'The command exits with status 0 in both cases. It reports the status',
				'"retained" or "build required" for each root.'
			].join('\n')
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
				name: RootName | undefined,
				targets: string[],
				options: RootEnsureOptions
			) => {
				if (options.plan !== undefined) {
					if (name !== undefined || targets.length > 0) {
						throw new RootEnsureArgumentsError('plan-with-root');
					}

					await ensurePlanRoots(url, options.plan, options);
					return;
				}

				if (name === undefined || targets.length === 0) {
					throw new RootEnsureArgumentsError('root-required');
				}

				validateRootTargets(targets);
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
					rootRetentionChoice(options.ttl, options.permanent),
					reporter,
					rpc.roots
				);
			}
		);

	root
		.command('set')
		.description(
			"Create a retention root, or replace an existing root's targets."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'root name (e.g. github:acme/app/main)', parseRootName)
		.argument('<store-path...>', 'the store paths for the root to keep')
		.option(
			'--ttl <duration>',
			'expire the root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--permanent', 'keep the root permanently')
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				"  # Keep a branch's build outputs for 30 days",
				'  cupboard root set https://cupboard.example.workers.dev/t/acme \\',
				'    github:acme/app/main /nix/store/<hash>-app --ttl 30d'
			].join('\n')
		)
		.action(
			async (
				url: URL,
				name: RootName,
				targets: string[],
				options: RootSetOptions
			) => {
				validateRootTargets(targets);
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
					rootRetentionChoice(options.ttl, options.permanent),
					reporter,
					rpc.roots
				);
			}
		);

	root
		.command('list')
		.description(
			"List a cache's retention roots, with their target counts and expiry."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[cache]', 'cache name, if the URL is a tenant URL')
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
		.description(
			"List a retention root's targets, and show which of them the cache is missing."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'root name (e.g. github:acme/app/main)', parseRootName)
		.option(
			'--github-oidc',
			"sign in with the job's GitHub Actions OIDC token instead of your saved `cupboard login` session"
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
		.argument('<name>', 'name of the root to remove', parseRootName)
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: URL, name: RootName, options: RootOptions) => {
			const target = cacheTargetFromUrl(url);
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(target.tenantUrl, {
				credential: cachedOwnerProvider(target.tenantUrl, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal,
				fetcher: acceptingCapability(rootRemoveLeftoverTargetsCapability)
			});

			await runRootRemove(target.cache, name, ui, rpc.roots);
		});
}

export async function runRootEnsure(
	cache: CacheScope,
	name: RootName,
	targets: readonly string[],
	retention: RootRetentionRequest,
	reporter: Reporter,
	client: Pick<RootClient, 'ensure'>
): Promise<void> {
	validateRootTargets(targets);
	const result = await reporter.phase('Checking retention root', () =>
		callInCache(client.ensure, cache, {
			name,
			targets: [...targets],
			retention
		})
	);

	reporter.result({
		kind: 'root-ensure',
		title: 'Retention root',
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

function ensureEntries(
	roots: readonly RetainedRoot[],
	retention: RootRetentionRequest
): readonly RootBatchEntry[] {
	return roots.map((root) => ({
		action: 'ensure',
		name: root.name,
		targets: [...root.targets],
		retention
	}));
}

/**
Ensures the root of every retained target in a plan through batched requests
and reports one result per root. When the cache cannot serve all of a root's
targets, the root is left unchanged and reported as requiring a build.
*/
export async function runRootEnsurePlan(
	cache: CacheScope,
	roots: readonly RetainedRoot[],
	retention: RootRetentionRequest,
	reporter: Reporter,
	client: Pick<RootClient, 'batch' | 'ensure'>
): Promise<void> {
	const results: readonly RootBatchResult[] =
		roots.length === 0
			? []
			: await reporter.phase('Ensuring retention roots', () =>
					ensureRoots(cache, ensureEntries(roots, retention), client)
				);

	reportRootEnsures(reporter, results);
}

// A server from before `roots.batch` gets one ensure per root, with the same
// result for each root.
async function ensureRoots(
	cache: CacheScope,
	entries: readonly RootBatchEntry[],
	client: Pick<RootClient, 'batch' | 'ensure'>
): Promise<readonly RootBatchResult[]> {
	try {
		return await applyRootBatches(
			(body) => callInCache(client.batch, cache, body),
			entries
		);
	} catch (error) {
		if (!isRpcProcedureMissingError(error)) {
			throw error;
		}
	}

	return mapWithConcurrency(
		entries,
		separateRootRequestConcurrency,
		async ({ name, targets, retention }): Promise<RootBatchResult> => {
			const response = await callInCache(client.ensure, cache, {
				name,
				targets: [...targets],
				retention
			});

			return response.status === 'retained'
				? { name, status: 'retained', root: response.root }
				: { name, status: 'build-required', unavailable: response.unavailable };
		}
	);
}

function reportRootEnsures(
	reporter: Reporter,
	results: readonly RootBatchResult[]
): void {
	reporter.result({
		kind: 'root-ensures',
		title: 'Retention roots',
		data: results,
		rows: results.flatMap((result) => [
			{
				label: result.name,
				value:
					result.status === 'retained'
						? `retained, ${describeExpiry(result.root)}`
						: `build required, ${String(result.unavailable.length)} unavailable`
			},
			...(result.status === 'retained'
				? []
				: result.unavailable.map((storePath) => ({
						label: 'Unavailable',
						value: storePath
					})))
		]),
		empty: 'The plan has no retained targets.'
	});
}

export async function runRootSet(
	cache: CacheScope,
	name: RootName,
	targets: readonly string[],
	retention: RootRetentionRequest,
	reporter: Reporter,
	client: Pick<RootClient, 'set'>
): Promise<void> {
	validateRootTargets(targets);
	const summary = await reporter.phase('Setting retention root', () =>
		callInCache(client.set, cache, {
			name,
			targets: [...targets],
			retention
		})
	);

	reporter.result({
		kind: 'root',
		title: 'Retention root',
		data: summary,
		rows: [
			{ label: 'Root', value: summary.name },
			{ label: 'Store paths', value: String(summary.targets.length) },
			{ label: 'Expiry', value: describeExpiry(summary) }
		]
	});
}

export async function runRootList(
	cache: CacheScope,
	reporter: Reporter,
	client: Pick<RootClient, 'list'>
): Promise<void> {
	const roots = await reporter.phase('Listing retention roots', async () =>
		collectProgressively(
			await cursorPages<RootListEntry, string>(
				async (cursor, signal) => {
					const page = await callInCache(
						client.list,
						cache,
						{ ...(cursor !== undefined && { cursor }) },
						{ signal }
					);

					return { items: page.roots, next: page.cursor };
				},
				procedureDeadline(
					'roots.list',
					tenantContract.roots.list.inDefaultCache
				)
			),
			listingLimits('The retention root listing')
		)
	);

	reporter.result({
		kind: 'roots',
		title: 'Retention roots',
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
	const targets = await reporter.phase('Listing root targets', async () =>
		collectProgressively(
			await cursorPages<RootTarget, string>(
				async (cursor, signal) => {
					const page = await callInCache(
						client.targets,
						cache,
						{ name, ...(cursor !== undefined && { cursor }) },
						{ signal }
					);

					return { items: page.targets, next: page.cursor };
				},
				procedureDeadline(
					'roots.targets',
					tenantContract.roots.targets.inDefaultCache
				)
			),
			listingLimits('The root target listing')
		)
	);

	reporter.result({
		kind: 'root-targets',
		title: 'Retained store paths',
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
		detail:
			'Paths kept only by this root may be deleted after any grace period expires.'
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
		title: 'Retention root',
		data: result,
		rows: [
			{ label: 'Root', value: result.name },
			{ label: 'Removed', value: describeRemoval(result) }
		]
	});
}

function describeRemoval(result: RootRemoveResponse): string {
	if (result.removed) {
		return 'yes';
	}

	if (result.releasedLeftoverTargets === true) {
		return 'not present; its leftover store paths are released';
	}

	return 'not present';
}

function rootListRow(root: RootListEntry): ResultRow {
	return {
		label: root.name,
		value: `${String(root.targetCount)} store ${root.targetCount === 1 ? 'path' : 'paths'}; ${describeExpiry(root)}`
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

function validateRootTargets(targets: readonly string[]): void {
	if (targets.length > rootSetMaxTargets) {
		throw new RootTargetLimitError(targets.length, rootSetMaxTargets);
	}
}
