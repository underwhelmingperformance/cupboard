import type { CliUi } from '@cupboard/cli-ui';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	type CachePriority,
	cachePrioritySchema,
	type CacheScope,
	type GraceSeconds,
	type RootName,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import type {
	CacheListResponse,
	CachePutBody,
	CacheRemoveResponse,
	CacheRootRetention,
	CacheSummary,
	CacheUpdateBody
} from '@cupboard/protocol/caches';
import {
	formatCount,
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { managedCacheProvisionAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush, cachedOwnerProvider } from '../auth/auth.ts';
import { parseCacheAccess } from '../cache-access.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { cacheLabel, CupboardClient } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { isRpcNotFoundError } from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseGrace, parseTtl } from '../duration.ts';
import {
	InvalidCachePriorityError,
	NamedCacheTargetRequiredError,
	RootRetentionOptionError
} from '../errors.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface CacheCreateOptions {
	readonly access?: CacheAccessMode;
	readonly priority?: CachePriority;
	readonly rootTtl?: TtlSeconds;
	readonly grace?: GraceSeconds;
}

interface CacheProvisionOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

interface CacheSetAccessOptions {
	readonly access: CacheAccessMode;
}

interface CacheSetPriorityOptions {
	readonly priority: CachePriority;
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
}

export interface CacheClient {
	list(): Promise<CacheListResponse>;
	get: CacheScopedClient<Record<never, never>, CacheSummary>;
	put: CacheScopedClient<CachePutBody, CacheSummary>;
	update: CacheScopedClient<CacheUpdateBody, CacheSummary>;
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
			const { tenantUrl } = cacheTargetFromUrl(url);
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(tenantUrl, {
				credential: cachedOwnerProvider(tenantUrl, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal
			});

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
		.action(
			async (
				url: URL,
				name: string | undefined,
				options: CacheCreateOptions
			) => {
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					name === undefined ? urlTarget : cacheTargetWithName(urlTarget, name);

				if (target.cache.kind === 'default') {
					throw new NamedCacheTargetRequiredError('Cache creation');
				}

				const reporter = commandUi(program, programOptions).reporter();
				const rpc = tenantRpc(target.tenantUrl, {
					credential: cachedOwnerProvider(target.tenantUrl, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

				await runCacheCreate(
					target.cache,
					options.access ?? 'public',
					options.priority ?? CacheInfo.default.priority,
					options.rootTtl,
					options.grace,
					reporter,
					rpc.caches
				);
			}
		);

	cache
		.command('provision')
		.description(
			'Provision a managed cache from the current GitHub OIDC policy.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'cache name when the URL does not select one')
		.requiredOption(
			'--github-oidc',
			'authenticate with the GitHub Actions OIDC rule that grants this managed cache'
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
				options: CacheProvisionOptions
			) => {
				const target = cacheCommandTarget(url, name);

				if (target.cache.kind === 'default') {
					throw new NamedCacheTargetRequiredError('Managed cache provision');
				}
				const cacheName = target.cache.name;

				const credential = await authenticateForPush(
					CupboardClient.fromUrl(target.tenantUrl, {
						cache: target.cache,
						signal: programOptions.signal
					}),
					{
						githubOidc: options.githubOidc,
						audience:
							options.audience ?? audienceSchema.parse(target.tenantUrl),
						authorizationDetails: managedCacheProvisionAuthorizationDetails({
							cache: target.cache
						})
					}
				);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = tenantRpc(target.tenantUrl, {
					credential,
					signal: programOptions.signal
				});
				const summary = await reporter.phase('Provisioning managed cache', () =>
					rpc.managedCaches.provision({ cacheName })
				);

				reporter.result({
					kind: 'cache',
					data: summary,
					rows: summaryRows(summary)
				});
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
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					name === undefined ? urlTarget : cacheTargetWithName(urlTarget, name);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = tenantRpc(target.tenantUrl, {
					credential: cachedOwnerProvider(target.tenantUrl, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

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
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					name === undefined ? urlTarget : cacheTargetWithName(urlTarget, name);
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = tenantRpc(target.tenantUrl, {
					credential: cachedOwnerProvider(target.tenantUrl, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

				await runCacheSetPriority(
					target.cache,
					options.priority,
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
		.action(
			async (
				url: URL,
				name: string | undefined,
				options: CacheRemoveOptions
			) => {
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					name === undefined ? urlTarget : cacheTargetWithName(urlTarget, name);

				if (target.cache.kind === 'default') {
					throw new NamedCacheTargetRequiredError('Cache removal');
				}

				const ui = commandUi(program, programOptions, {
					assumeYes: options.yes
				});
				const rpc = tenantRpc(target.tenantUrl, {
					credential: cachedOwnerProvider(target.tenantUrl, {
						signal: programOptions.signal
					}),
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
			const urlTarget = cacheTargetFromUrl(url);
			const target =
				name === undefined ? urlTarget : cacheTargetWithName(urlTarget, name);
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(target.tenantUrl, {
				credential: cachedOwnerProvider(target.tenantUrl, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal
			});

			await runCacheInspect(target.cache, reporter, rpc.caches);
		});
}

export async function runCacheList(
	reporter: Reporter,
	client: Pick<CacheClient, 'list'>
): Promise<void> {
	const { caches } = await reporter.phase('Listing caches', () =>
		client.list()
	);

	reporter.result({
		kind: 'caches',
		data: caches,
		rows: caches.map((summary) => cacheRow(summary)),
		empty: 'No caches.'
	});
}

export async function runCacheCreate(
	cache: Extract<CacheScope, { readonly kind: 'named' }>,
	access: CacheAccessMode,
	priority: CachePriority,
	rootTtl: TtlSeconds | undefined,
	grace: GraceSeconds | undefined,
	reporter: Reporter,
	client: Pick<CacheClient, 'put'>
): Promise<void> {
	const summary = await reporter.phase('Creating cache', () =>
		callInCache(client.put, cache, {
			access,
			priority,
			defaultRootRetention:
				rootTtl === undefined
					? { kind: 'permanent' }
					: { kind: 'duration', seconds: rootTtl },
			grace:
				grace === undefined
					? { kind: 'none' }
					: { kind: 'duration', graceSeconds: grace }
		})
	);

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

function cacheRow(summary: CacheSummary): ResultRow {
	const parts = [
		summary.access,
		`priority ${String(summary.priority)}`,
		`${formatCount(summary.storePaths)} path(s)`,
		`default root retention ${rootRetentionLabel(summary.defaultRootRetention)}`,
		`grace ${graceLabel(summary.grace)}`,
		`${formatCount(summary.rootRetentionOverrides.length)} root retention override(s)`
	];

	if (summary.graceManaged === true) {
		parts.push('grace-managed');
	}

	if (summary.earliestGraceDeadline !== undefined) {
		parts.push(
			`earliest deadline ${formatTimestamp(summary.earliestGraceDeadline)}`
		);
	}

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
		}
	];

	if (summary.graceManaged !== undefined) {
		rows.push({
			label: 'Grace managed',
			value: summary.graceManaged ? 'yes' : 'no'
		});
	}

	if (summary.earliestGraceDeadline !== undefined) {
		rows.push({
			label: 'Earliest grace deadline',
			value: formatTimestamp(summary.earliestGraceDeadline)
		});
	}

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
