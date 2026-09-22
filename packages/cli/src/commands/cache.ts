import type { CliUi } from '@cupboard/cli-ui';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	type CacheName,
	type CachePriority,
	cachePrioritySchema,
	type CacheScope,
	type GraceSeconds,
	type RootName,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import type {
	CacheListEntry,
	CacheListInput,
	CacheListResponse,
	CachePutBody,
	CacheRemoveResponse,
	CacheSummary,
	CacheUpdateBody
} from '@cupboard/protocol/caches';
import type { CacheRootRetention } from '@cupboard/protocol/retention';
import {
	formatCount,
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import {
	cacheCreateAuthorizationDetails,
	cacheRemoveAuthorizationDetails
} from '../auth/attenuate.ts';
import { authenticateForPush, cachedOwnerProvider } from '../auth/auth.ts';
import { parseCacheAccess } from '../cache-access.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { cacheLabel, CupboardClient } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import {
	isRpcCacheAlreadyExistsError,
	isRpcNotFoundError
} from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseGrace, parseTtl } from '../duration.ts';
import {
	InvalidCachePriorityError,
	InvalidCacheRetirementChoiceError,
	NamedCacheTargetRequiredError,
	RootRetentionOptionError
} from '../errors.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface CacheCreateOptions {
	readonly access: CacheAccessMode;
	readonly priority?: CachePriority;
	readonly rootTtl?: TtlSeconds;
	readonly grace?: GraceSeconds;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly ifAbsent?: boolean;
}

interface CacheSetAccessOptions {
	readonly access: CacheAccessMode;
}

interface CacheSetPriorityOptions {
	readonly priority: CachePriority;
}

interface CacheSetRetirementOptions {
	readonly whenEmpty: boolean;
}

interface CacheSetRootTtlOptions {
	readonly rootPrefix?: RootName;
	readonly rootTtl?: TtlSeconds;
	readonly permanent?: boolean;
}

interface CacheClearRootTtlOptions {
	readonly rootPrefix?: RootName;
}

interface CacheSetGraceOptions {
	readonly grace: GraceSeconds;
}

interface CacheRemoveOptions {
	readonly force?: boolean;
	readonly yes?: boolean;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

export interface CacheClient {
	list(input?: CacheListInput): Promise<CacheListResponse>;
	get: CacheScopedClient<object, CacheSummary>;
	put: CacheScopedClient<CachePutBody, CacheSummary>;
	update: CacheScopedClient<CacheUpdateBody, CacheSummary>;
	retirement(input: {
		cacheName: CacheName;
		retireWhenEmpty: boolean;
	}): Promise<CacheSummary>;
	remove(input: {
		params: { cacheName: string };
		query?: { force?: boolean };
	}): Promise<CacheRemoveResponse>;
}

export function parsePriority(value: string): CachePriority {
	// Canonical decimal only: a leading zero is as non-canonical as hex or
	// exponent forms, so it is rejected the same way.
	if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
		throw new InvalidCachePriorityError(value);
	}

	const priority = Number(value);

	if (!Number.isSafeInteger(priority)) {
		throw new InvalidCachePriorityError(value);
	}

	return cachePrioritySchema.parse(priority);
}

export function isRetirementEnabled(value: string): boolean {
	if (value === 'true') {
		return true;
	}

	if (value === 'false') {
		return false;
	}

	throw new InvalidCacheRetirementChoiceError(value);
}

export function registerCacheCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const cache = program
		.command('cache')
		.description(
			'Manage caches: list, create, inspect, update properties and remove.'
		);

	cache
		.command('list')
		.description('List caches and their properties.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const { tenantUrl } = cacheCommandTarget(url, undefined);
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = cacheRpc(tenantUrl, programOptions);

			await runCacheList(reporter, rpc.caches);
		});

	cache
		.command('create')
		.description('Create a named cache.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'cache name when the URL does not select one')
		.requiredOption(
			'--access <mode>',
			'read access: public or private',
			parseCacheAccess
		)
		.option(
			'--priority <n>',
			'Nix substituter priority (lower is preferred)',
			parsePriority
		)
		.option(
			'--root-ttl <duration>',
			'default TTL for roots (e.g. 14d, 12h)',
			parseTtl
		)
		.option(
			'--grace <duration>',
			'retention grace period (e.g. 24h, 0s)',
			parseGrace
		)
		.option(
			'--if-absent',
			'report the existing cache instead of failing when it is already there'
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
				name: string | undefined,
				options: CacheCreateOptions
			) => {
				const target = cacheCommandTarget(url, name);

				if (target.cache.kind === 'default') {
					throw new NamedCacheTargetRequiredError('Cache creation');
				}

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
						authorizationDetails: cacheCreateAuthorizationDetails({
							cache: target.cache
						})
					}
				);
				const rpc = tenantRpc(target.tenantUrl, {
					credential,
					signal: programOptions.signal
				});

				await runCacheCreate(
					{
						cache: target.cache,
						access: options.access,
						priority: options.priority ?? CacheInfo.default.priority,
						...(options.rootTtl !== undefined && { rootTtl: options.rootTtl }),
						...(options.grace !== undefined && { grace: options.grace }),
						...(options.ifAbsent === true && { ifAbsent: true })
					},
					reporter,
					rpc.caches
				);
			}
		);

	cache
		.command('set-root-ttl')
		.description("Set a cache's default root TTL or a root-prefix override.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.option(
			'--root-prefix <prefix>',
			'root-name prefix to override',
			parseRootName
		)
		.option('--root-ttl <duration>', 'root TTL (e.g. 14d, 12h)', parseTtl)
		.option('--permanent', 'retain roots permanently')
		.action(
			async (
				url: URL,
				name: string | undefined,
				options: CacheSetRootTtlOptions
			) => {
				const target = cacheCommandTarget(url, name);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = cacheRpc(target.tenantUrl, programOptions);

				const retention = cacheRootRetention(options);

				await runCacheSetRootTtl(
					target.cache,
					options.rootPrefix,
					retention,
					reporter,
					rpc.caches
				);
			}
		);

	cache
		.command('clear-root-ttl')
		.description("Clear a cache's default root TTL or a root-prefix override.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.option(
			'--root-prefix <prefix>',
			'root-name prefix override to clear',
			parseRootName
		)
		.action(
			async (
				url: URL,
				name: string | undefined,
				options: CacheClearRootTtlOptions
			) => {
				const target = cacheCommandTarget(url, name);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = cacheRpc(target.tenantUrl, programOptions);

				await runCacheClearRootTtl(
					target.cache,
					options.rootPrefix,
					reporter,
					rpc.caches
				);
			}
		);

	cache
		.command('set-grace')
		.description("Set a cache's retention grace period.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.requiredOption(
			'--grace <duration>',
			'retention grace period (e.g. 24h, 0s)',
			parseGrace
		)
		.action(
			async (
				url: URL,
				name: string | undefined,
				options: CacheSetGraceOptions
			) => {
				const target = cacheCommandTarget(url, name);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = cacheRpc(target.tenantUrl, programOptions);

				await runCacheSetGrace(
					target.cache,
					options.grace,
					reporter,
					rpc.caches
				);
			}
		);

	cache
		.command('clear-grace')
		.description("Clear a cache's retention grace period.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.action(async (url: URL, name: string | undefined) => {
			const target = cacheCommandTarget(url, name);
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = cacheRpc(target.tenantUrl, programOptions);

			await runCacheClearGrace(target.cache, reporter, rpc.caches);
		});

	cache
		.command('set-access')
		.description("Set a cache's read access.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.requiredOption(
			'--access <mode>',
			'read access: public or private',
			parseCacheAccess
		)
		.action(
			async (
				url: URL,
				name: string | undefined,
				options: CacheSetAccessOptions
			) => {
				const target = cacheCommandTarget(url, name);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = cacheRpc(target.tenantUrl, programOptions);

				await runCacheSetAccess(
					target.cache,
					options.access,
					reporter,
					rpc.caches
				);
			}
		);

	cache
		.command('set-priority')
		.description("Set a cache's Nix substituter priority.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.requiredOption(
			'--priority <n>',
			'Nix substituter priority (lower is preferred)',
			parsePriority
		)
		.action(
			async (
				url: URL,
				name: string | undefined,
				options: CacheSetPriorityOptions
			) => {
				const target = cacheCommandTarget(url, name);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = cacheRpc(target.tenantUrl, programOptions);

				await runCacheSetPriority(
					target.cache,
					options.priority,
					reporter,
					rpc.caches
				);
			}
		);

	cache
		.command('set-retirement')
		.description('Opt a named cache in or out of retirement when empty.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'cache name when the URL does not select one')
		.requiredOption(
			'--when-empty <choice>',
			'true to retire when empty, false to keep the cache',
			isRetirementEnabled
		)
		.action(
			async (
				url: URL,
				name: string | undefined,
				options: CacheSetRetirementOptions
			) => {
				const target = cacheCommandTarget(url, name);

				if (target.cache.kind === 'default') {
					throw new NamedCacheTargetRequiredError('Cache retirement');
				}

				const reporter = commandUi(program, programOptions).reporter();
				const rpc = cacheRpc(target.tenantUrl, programOptions);

				await runCacheSetRetirement(
					target.cache.name,
					options.whenEmpty,
					reporter,
					rpc.caches
				);
			}
		);

	cache
		.command('remove')
		.description('Remove a named cache.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'cache name when the URL does not select one')
		.option('--force', 'remove even when the cache still holds store paths')
		.option('-y, --yes', 'remove without the confirmation prompt')
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
				name: string | undefined,
				options: CacheRemoveOptions
			) => {
				const target = cacheCommandTarget(url, name);

				if (target.cache.kind === 'default') {
					throw new NamedCacheTargetRequiredError('Cache removal');
				}

				const ui = commandUi(program, programOptions, {
					assumeYes: options.yes
				});
				const credential = await authenticateForPush(
					CupboardClient.fromUrl(target.tenantUrl, {
						cache: target.cache,
						signal: programOptions.signal
					}),
					{
						githubOidc: options.githubOidc,
						audience:
							options.audience ?? audienceSchema.parse(target.tenantUrl),
						authorizationDetails: cacheRemoveAuthorizationDetails({
							cache: target.cache
						})
					}
				);
				const rpc = tenantRpc(target.tenantUrl, {
					credential,
					signal: programOptions.signal
				});

				await runCacheRemove(
					target.cache.name,
					options.force ?? false,
					ui,
					rpc.caches
				);
			}
		);

	cache
		.command('inspect')
		.description("Show one cache's properties and store-path count.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.action(async (url: URL, name: string | undefined) => {
			const target = cacheCommandTarget(url, name);
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = cacheRpc(target.tenantUrl, programOptions);

			await runCacheInspect(target.cache, reporter, rpc.caches);
		});
}

export async function runCacheList(
	reporter: Reporter,
	client: Pick<CacheClient, 'list'>
): Promise<void> {
	const caches = await reporter.phase('Listing caches', async () => {
		const summaries: CacheListEntry[] = [];
		let cursor: string | undefined;

		do {
			const page =
				cursor === undefined
					? await client.list()
					: await client.list({ cursor });
			summaries.push(...page.caches);
			cursor = page.cursor;
		} while (cursor !== undefined);

		return summaries;
	});

	reporter.result({
		kind: 'caches',
		data: caches,
		rows: caches.map((summary) => cacheRow(summary)),
		empty: 'No caches.'
	});
}

export interface CacheCreateRequest {
	readonly cache: Extract<CacheScope, { readonly kind: 'named' }>;
	readonly access: CacheAccessMode;
	readonly priority: CachePriority;
	readonly rootTtl?: TtlSeconds;
	readonly grace?: GraceSeconds;
	/**
	 * Report an existing cache without changing its properties.
	 */
	readonly ifAbsent?: boolean;
}

export async function runCacheCreate(
	request: CacheCreateRequest,
	reporter: Reporter,
	client: Pick<CacheClient, 'put' | 'get'>
): Promise<void> {
	const summary = await reporter.phase('Creating cache', async () => {
		try {
			return await callInCache(client.put, request.cache, {
				access: request.access,
				priority: request.priority,
				defaultRootRetention:
					request.rootTtl === undefined
						? { kind: 'permanent' }
						: { kind: 'duration', seconds: request.rootTtl },
				grace:
					request.grace === undefined
						? { kind: 'none' }
						: { kind: 'duration', graceSeconds: request.grace }
			});
		} catch (error) {
			if (request.ifAbsent !== true || !isRpcCacheAlreadyExistsError(error)) {
				throw error;
			}

			return callInCache(client.get, request.cache, {});
		}
	});

	reporter.result({ kind: 'cache', data: summary, rows: summaryRows(summary) });
}

export async function runCacheSetAccess(
	cache: CacheScope,
	access: CacheAccessMode,
	reporter: Reporter,
	client: Pick<CacheClient, 'update'>
): Promise<void> {
	const summary = await reporter.phase('Setting cache access', () =>
		callInCache(client.update, cache, { kind: 'access', access })
	);

	reporter.result({ kind: 'cache', data: summary, rows: summaryRows(summary) });
}

export async function runCacheSetPriority(
	cache: CacheScope,
	priority: CachePriority,
	reporter: Reporter,
	client: Pick<CacheClient, 'update'>
): Promise<void> {
	const summary = await reporter.phase('Setting cache priority', () =>
		callInCache(client.update, cache, { kind: 'priority', priority })
	);

	reporter.result({ kind: 'cache', data: summary, rows: summaryRows(summary) });
}

export async function runCacheSetRetirement(
	cacheName: CacheName,
	shouldRetireWhenEmpty: boolean,
	reporter: Reporter,
	client: Pick<CacheClient, 'retirement'>
): Promise<void> {
	const summary = await reporter.phase('Setting cache retirement', () =>
		client.retirement({ cacheName, retireWhenEmpty: shouldRetireWhenEmpty })
	);

	const result = {
		...summary,
		retireWhenEmpty: summary.retireWhenEmpty ?? shouldRetireWhenEmpty
	};

	reporter.result({ kind: 'cache', data: result, rows: summaryRows(result) });
}

export async function runCacheSetRootTtl(
	cache: CacheScope,
	rootPrefix: RootName | undefined,
	retention: CacheRootRetention,
	reporter: Reporter,
	client: Pick<CacheClient, 'update'>
): Promise<void> {
	const body: CacheUpdateBody =
		rootPrefix === undefined
			? { kind: 'set-default-root-ttl', retention }
			: { kind: 'set-root-ttl-override', rootPrefix, retention };

	await runCacheUpdate(cache, body, 'Setting cache root TTL', reporter, client);
}

export async function runCacheClearRootTtl(
	cache: CacheScope,
	rootPrefix: RootName | undefined,
	reporter: Reporter,
	client: Pick<CacheClient, 'update'>
): Promise<void> {
	const body: CacheUpdateBody =
		rootPrefix === undefined
			? { kind: 'set-default-root-ttl', retention: { kind: 'permanent' } }
			: { kind: 'clear-root-ttl-override', rootPrefix };

	await runCacheUpdate(
		cache,
		body,
		'Clearing cache root TTL',
		reporter,
		client
	);
}

export async function runCacheSetGrace(
	cache: CacheScope,
	graceSeconds: GraceSeconds,
	reporter: Reporter,
	client: Pick<CacheClient, 'update'>
): Promise<void> {
	await runCacheUpdate(
		cache,
		{ kind: 'set-grace', graceSeconds },
		'Setting cache grace',
		reporter,
		client
	);
}

export async function runCacheClearGrace(
	cache: CacheScope,
	reporter: Reporter,
	client: Pick<CacheClient, 'update'>
): Promise<void> {
	await runCacheUpdate(
		cache,
		{ kind: 'clear-grace' },
		'Clearing cache grace',
		reporter,
		client
	);
}

async function runCacheUpdate(
	cache: CacheScope,
	body: CacheUpdateBody,
	phase: string,
	reporter: Reporter,
	client: Pick<CacheClient, 'update'>
): Promise<void> {
	const summary = await reporter.phase(phase, () =>
		callInCache(client.update, cache, body)
	);

	reporter.result({ kind: 'cache', data: summary, rows: summaryRows(summary) });
}

export async function runCacheRemove(
	name: string,
	shouldForce: boolean,
	ui: CliUi,
	client: CacheClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove cache ${name}?`,
		detail: shouldForce
			? 'With --force this removes the cache and every store path it holds.'
			: 'The cache must be empty; pass --force to remove one that still holds paths.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The cache was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Removing cache', () =>
		client.remove({
			params: { cacheName: name },
			query: { force: shouldForce }
		})
	);

	reporter.result({
		kind: 'cache',
		data: result,
		rows: [
			{ label: 'Cache', value: cacheLabel(result.scope) },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' },
			{
				label: 'Store paths removed',
				value: formatCount(result.storePathsRemoved)
			}
		]
	});
}

export async function runCacheInspect(
	cache: CacheScope,
	reporter: Reporter,
	client: Pick<CacheClient, 'get'>
): Promise<void> {
	const summary = await reporter.phase('Inspecting cache', () =>
		exactCache(client.get, cache)
	);

	if (summary === undefined) {
		reporter.info(
			cache.kind === 'default'
				? 'The default cache does not exist.'
				: `No cache named ${cache.name}.`
		);
		return;
	}

	reporter.result({ kind: 'cache', data: summary, rows: summaryRows(summary) });
}

async function exactCache(
	client: CacheClient['get'],
	cache: CacheScope
): Promise<CacheSummary | undefined> {
	try {
		return await callInCache(client, cache, {});
	} catch (error) {
		if (isRpcNotFoundError(error)) {
			return undefined;
		}

		throw error;
	}
}

function cacheRow(summary: CacheListEntry): ResultRow {
	const parts = [
		summary.access,
		`priority ${String(summary.priority)}`,
		`${formatCount(summary.storePaths)} path(s)`,
		`default root retention ${rootRetentionLabel(summary.defaultRootRetention)}`,
		`grace ${graceLabel(summary.grace)}`,
		summary.rootRetentionOverrides === undefined
			? 'root retention overrides: use cache inspect'
			: `${formatCount(summary.rootRetentionOverrides.length)} root retention override(s)`,
		...(summary.graceManaged === true ? ['grace-managed'] : []),
		...(summary.earliestGraceDeadline === undefined
			? []
			: [
					`earliest deadline ${formatTimestamp(summary.earliestGraceDeadline)}`
				]),
		...(summary.retireWhenEmpty === undefined
			? []
			: [summary.retireWhenEmpty ? 'retire when empty' : 'keep when empty']),
		...(summary.retirementEligibleAfter === undefined
			? []
			: [
					`retirement eligible after ${formatTimestamp(summary.retirementEligibleAfter)}`
				])
	];

	return {
		label: cacheLabel(summary.scope),
		value: parts.join('; ')
	};
}

// The grace rows only render when the server reports grace state, so a summary
// from a server that predates it lists without them.
function summaryRows(summary: CacheSummary): ResultRow[] {
	const rows: ResultRow[] = [
		{ label: 'Cache', value: cacheLabel(summary.scope) },
		{ label: 'Access', value: summary.access },
		{ label: 'Priority', value: String(summary.priority) },
		{ label: 'Store paths', value: formatCount(summary.storePaths) },
		{
			label: 'Default root retention',
			value: rootRetentionLabel(summary.defaultRootRetention)
		},
		{ label: 'Grace', value: graceLabel(summary.grace) },
		{
			label: 'Root retention overrides',
			value:
				summary.rootRetentionOverrides.length === 0
					? 'none'
					: summary.rootRetentionOverrides
							.map(
								({ rootPrefix, retention }) =>
									`${rootPrefix} = ${rootRetentionLabel(retention)}`
							)
							.join('; ')
		},
		...(summary.graceManaged === undefined
			? []
			: [
					{ label: 'Grace managed', value: summary.graceManaged ? 'yes' : 'no' }
				]),
		...(summary.earliestGraceDeadline === undefined
			? []
			: [
					{
						label: 'Earliest grace deadline',
						value: formatTimestamp(summary.earliestGraceDeadline)
					}
				]),
		...(summary.retireWhenEmpty === undefined
			? []
			: [
					{
						label: 'Retire when empty',
						value: summary.retireWhenEmpty ? 'yes' : 'no'
					}
				]),
		...(summary.retirementEligibleAfter === undefined
			? []
			: [
					{
						label: 'Retirement eligible after',
						value: formatTimestamp(summary.retirementEligibleAfter)
					}
				])
	];

	return rows;
}

function rootRetentionLabel(retention: CacheRootRetention): string {
	return retention.kind === 'permanent'
		? 'permanent'
		: `${formatCount(retention.seconds)}s`;
}

function cacheRootRetention(
	options: CacheSetRootTtlOptions
): CacheRootRetention {
	if (options.rootTtl !== undefined && options.permanent !== true) {
		return { kind: 'duration', seconds: options.rootTtl };
	}

	if (options.rootTtl === undefined && options.permanent === true) {
		return { kind: 'permanent' };
	}

	throw new RootRetentionOptionError();
}

function graceLabel(grace: CacheSummary['grace']): string {
	return grace.kind === 'none' ? 'none' : `${formatCount(grace.graceSeconds)}s`;
}

function cacheCommandTarget(url: URL, name: string | undefined) {
	const urlTarget = cacheTargetFromUrl(url);

	return name === undefined ? urlTarget : cacheTargetWithName(urlTarget, name);
}

function cacheRpc(tenantUrl: URL, programOptions: ProgramOptions) {
	return tenantRpc(tenantUrl, {
		credential: cachedOwnerProvider(tenantUrl, {
			signal: programOptions.signal
		}),
		signal: programOptions.signal
	});
}
