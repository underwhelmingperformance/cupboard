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
	CacheCloseResponse,
	CacheCreationDefaults,
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
	type ResultRow,
	shouldShowDebug,
	shouldShowDetails
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import {
	cacheCreateAuthorizationDetails,
	cacheLifecycleAuthorizationDetails,
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
	CacheDefaultsTenantUrlRequiredError,
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
	close(input: { cacheName: CacheName }): Promise<CacheCloseResponse>;
	reopen(input: { cacheName: CacheName }): Promise<CacheSummary>;
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
		.description("Create, inspect, configure and remove a tenant's caches.");

	cache
		.command('list')
		.description("List the tenant's caches and their settings.")
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const { tenantUrl } = cacheCommandTarget(url, undefined);
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = cacheRpc(tenantUrl, programOptions);

			await runCacheList(reporter, rpc.caches);
		});

	cache
		.command('defaults')
		.description('Inspect the tenant defaults for newly created caches.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const tenantUrl = cacheDefaultsTarget(url);
			const reporter = commandUi(program, programOptions).reporter();
			await runCacheCreationDefaults(
				reporter,
				cacheRpc(tenantUrl, programOptions).caches.defaults
			);
		});

	cache
		.command('set-default-grace')
		.description('Set the grace period inherited by newly created caches.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption(
			'--grace <duration>',
			'grace period (e.g. 24h, 0s)',
			parseGrace
		)
		.action(async (url: URL, options: CacheSetGraceOptions) => {
			const tenantUrl = cacheDefaultsTarget(url);
			const reporter = commandUi(program, programOptions).reporter();
			await runCacheCreationDefaults(
				reporter,
				cacheRpc(tenantUrl, programOptions).caches.defaults,
				{
					grace: { kind: 'duration', graceSeconds: options.grace }
				}
			);
		});

	cache
		.command('clear-default-grace')
		.description('Remove the grace default for newly created caches.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const tenantUrl = cacheDefaultsTarget(url);
			const reporter = commandUi(program, programOptions).reporter();
			await runCacheCreationDefaults(
				reporter,
				cacheRpc(tenantUrl, programOptions).caches.defaults,
				{
					grace: { kind: 'none' }
				}
			);
		});

	cache
		.command('create')
		.description('Create a named cache.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'cache name, if the URL is a tenant URL')
		.requiredOption(
			'--access <mode>',
			'read access: public or private',
			parseCacheAccess
		)
		.option(
			'--priority <n>',
			'substituter priority to advertise to Nix; Nix tries lower numbers first (default: 40)',
			parsePriority
		)
		.option(
			'--root-ttl <duration>',
			"default TTL for the cache's roots (e.g. 14d, 12h)",
			parseTtl
		)
		.option('--grace <duration>', 'grace period (e.g. 24h, 0s)', parseGrace)
		.option(
			'--if-absent',
			'if the cache already exists, show it and succeed instead of failing'
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
		.description(
			"Set a cache's default root TTL, or the TTL for roots whose names start with a prefix."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.option(
			'--root-prefix <prefix>',
			'set the TTL only for roots whose names start with this prefix',
			parseRootName
		)
		.option(
			'--root-ttl <duration>',
			'TTL for the roots (e.g. 14d, 12h)',
			parseTtl
		)
		.option('--permanent', 'keep the roots permanently')
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
		.description(
			"Clear a cache's default root TTL, or the TTL for a root-name prefix."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.option(
			'--root-prefix <prefix>',
			'clear the TTL for this root-name prefix only',
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
		.description(
			"Set a cache's grace period, which keeps store paths for a time even when no root keeps them."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.requiredOption(
			'--grace <duration>',
			'grace period (e.g. 24h, 0s)',
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
		.description("Remove a cache's grace period.")
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
		.description('Make a cache public or private.')
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
		.description('Set the substituter priority that a cache advertises to Nix.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'named cache; omit it for the default cache')
		.requiredOption(
			'--priority <n>',
			'substituter priority to advertise to Nix; Nix tries lower numbers first',
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
		.description(
			'Choose whether a named cache removes itself once it is empty.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'cache name, if the URL is a tenant URL')
		.requiredOption(
			'--when-empty <choice>',
			'true to remove the cache once it is empty, false to keep it',
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

	for (const action of ['close', 'reopen'] as const) {
		cache
			.command(action)
			.description(
				action === 'close'
					? 'Stop publication and expire the roots of a named cache with its configured grace.'
					: 'Restore publication to a closed named cache.'
			)
			.argument('<url>', tenantUrlArgument, parseWorkerUrl)
			.argument('[name]', 'cache name, if the URL is a tenant URL')
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
					name: string | undefined,
					options: Pick<CacheRemoveOptions, 'githubOidc' | 'audience'>
				) => {
					const target = cacheCommandTarget(url, name);
					if (target.cache.kind === 'default') {
						throw new NamedCacheTargetRequiredError(`Cache ${action}`);
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
							authorizationDetails: cacheLifecycleAuthorizationDetails({
								cache: target.cache,
								action
							})
						}
					);
					const rpc = tenantRpc(target.tenantUrl, {
						credential,
						signal: programOptions.signal
					});
					await runCacheLifecycle(
						target.cache.name,
						action,
						reporter,
						rpc.caches
					);
				}
			);
	}

	cache
		.command('remove')
		.description('Remove a named cache.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[name]', 'cache name, if the URL is a tenant URL')
		.option('--force', 'remove the cache even if it still has store paths')
		.option('-y, --yes', 'remove without the confirmation prompt')
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
		.description("Show one cache's settings and how many store paths it has.")
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
		title: 'Caches',
		data: caches,
		rows: caches.map((summary) => cacheRow(summary, reporter)),
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
	await reporter.phase('Creating cache', async (phase) => {
		const { summary, created } = await createCache(request, client);
		const rows = summaryRows(summary, reporter);

		phase.result({
			kind: 'cache',
			data: summary,
			rows: [
				...rows.slice(0, 1),
				{ label: 'Status', value: created ? 'Created' : 'Already existed' },
				...rows.slice(1)
			]
		});
	});
}

interface CreatedCache {
	readonly summary: CacheSummary;
	readonly created: boolean;
}

async function createCache(
	request: CacheCreateRequest,
	client: Pick<CacheClient, 'put' | 'get'>
): Promise<CreatedCache> {
	try {
		const summary = await callInCache(client.put, request.cache, {
			access: request.access,
			priority: request.priority,
			defaultRootRetention:
				request.rootTtl === undefined
					? { kind: 'permanent' }
					: { kind: 'duration', seconds: request.rootTtl },
			...(request.grace !== undefined && {
				grace: { kind: 'duration', graceSeconds: request.grace }
			})
		});
		return { summary, created: true };
	} catch (error) {
		if (request.ifAbsent !== true || !isRpcCacheAlreadyExistsError(error)) {
			throw error;
		}

		return {
			summary: await callInCache(client.get, request.cache, {}),
			created: false
		};
	}
}

export interface CacheCreationDefaultsClient {
	get(): Promise<CacheCreationDefaults>;
	set(configuration: CacheCreationDefaults): Promise<CacheCreationDefaults>;
}

export async function runCacheCreationDefaults(
	reporter: Reporter,
	client: CacheCreationDefaultsClient,
	configuration?: CacheCreationDefaults
): Promise<void> {
	const defaults = await reporter.phase(
		configuration === undefined
			? 'Inspecting cache creation defaults'
			: 'Setting cache creation defaults',
		() =>
			configuration === undefined ? client.get() : client.set(configuration)
	);
	reporter.result({
		kind: 'cache-defaults',
		title: 'New cache defaults',
		data: defaults,
		rows: [{ label: 'New cache grace', value: graceLabel(defaults.grace) }]
	});
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

	reporter.result({
		kind: 'cache',
		title: 'Cache',
		data: summary,
		rows: summaryRows(summary, reporter)
	});
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

	reporter.result({
		kind: 'cache',
		title: 'Cache',
		data: summary,
		rows: summaryRows(summary, reporter)
	});
}

export async function runCacheLifecycle(
	cacheName: CacheName,
	action: 'close' | 'reopen',
	reporter: Reporter,
	client: Pick<CacheClient, 'close' | 'reopen'>
): Promise<void> {
	const result = await reporter.phase<CacheCloseResponse | CacheSummary>(
		action === 'close' ? 'Closing cache' : 'Reopening cache',
		() => client[action]({ cacheName })
	);
	if ('closed' in result) {
		reporter.result({
			kind: 'cache-close',
			title: 'Cache publication',
			data: result,
			rows: [
				{ label: 'Cache', value: cacheLabel(result.scope) },
				{ label: 'Closed', value: result.closed ? 'yes' : 'not present' },
				...(result.retirementStartedAt === undefined
					? []
					: [
							{
								label: 'Closed at',
								value: formatTimestamp(result.retirementStartedAt)
							}
						])
			]
		});
		return;
	}
	reporter.result({
		kind: 'cache',
		title: 'Cache',
		data: result,
		rows: summaryRows(result, reporter)
	});
}

export async function runCacheSetRetirement(
	cacheName: CacheName,
	shouldRetireWhenEmpty: boolean,
	reporter: Reporter,
	client: Pick<CacheClient, 'retirement'>
): Promise<void> {
	const summary = await reporter.phase(
		'Setting cache retirement',
		() =>
			client.retirement({ cacheName, retireWhenEmpty: shouldRetireWhenEmpty }),
		{ humanLabel: 'Setting automatic cache removal' }
	);

	const result = {
		...summary,
		retireWhenEmpty: summary.retireWhenEmpty ?? shouldRetireWhenEmpty
	};

	reporter.result({
		kind: 'cache',
		title: 'Cache',
		data: result,
		rows: summaryRows(result, reporter)
	});
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

	reporter.result({
		kind: 'cache',
		title: 'Cache',
		data: summary,
		rows: summaryRows(summary, reporter)
	});
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
			? 'With --force this removes the cache and all its store paths. Background storage cleanup continues after removal.'
			: 'The cache must be empty; pass --force to remove one that still has store paths. Background storage cleanup continues after removal.'
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
		title: 'Cache',
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

	reporter.result({
		kind: 'cache',
		title: 'Cache',
		data: summary,
		rows: summaryRows(summary, reporter)
	});
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

function cacheRow(summary: CacheListEntry, reporter: Reporter): ResultRow {
	const parts = [
		summary.access,
		`${formatCount(summary.storePaths)} store ${summary.storePaths === 1 ? 'path' : 'paths'}`,
		`Nix priority ${String(summary.priority)}`,
		...(summary.retirementStartedAt === undefined
			? []
			: ['closed to publication']),
		...(summary.retireWhenEmpty === undefined
			? []
			: [summary.retireWhenEmpty ? 'remove when empty' : 'keep when empty']),
		...(summary.graceManaged === undefined
			? []
			: [cleanupConsequence(summary)]),
		...(shouldShowDetails(reporter)
			? [
					`default root retention ${rootRetentionLabel(summary.defaultRootRetention)}`,
					`grace ${graceLabel(summary.grace)}`,
					summary.rootRetentionOverrides === undefined
						? 'retention by root prefix: use cache inspect'
						: `${formatCount(summary.rootRetentionOverrides.length)} root-prefix rules`,
					...(summary.earliestGraceDeadline === undefined
						? []
						: [
								`earliest grace expiry ${formatTimestamp(summary.earliestGraceDeadline)}`
							]),
					...(summary.retirementEligibleAfter === undefined
						? []
						: [
								`may be removed after ${formatTimestamp(summary.retirementEligibleAfter)}, when empty`
							])
				]
			: []),
		...(shouldShowDebug(reporter) && summary.graceManaged !== undefined
			? [`grace-managed ${String(summary.graceManaged)}`]
			: [])
	];

	return { label: cacheLabel(summary.scope), value: parts.join('; ') };
}

function summaryRows(summary: CacheSummary, reporter: Reporter): ResultRow[] {
	return [
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
			label: 'Retention by root prefix',
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
			: [{ label: 'Unretained paths', value: cleanupConsequence(summary) }]),
		...(summary.retirementStartedAt === undefined
			? []
			: [
					{
						label: 'Publication',
						value: `Closed since ${formatTimestamp(summary.retirementStartedAt)}`
					}
				]),
		...(summary.retireWhenEmpty === undefined
			? []
			: [
					{
						label: 'Remove when empty',
						value: summary.retireWhenEmpty ? 'yes' : 'no'
					}
				]),
		...(summary.retirementEligibleAfter === undefined
			? []
			: [
					{
						label: 'Automatic removal',
						value: `May be removed after ${formatTimestamp(summary.retirementEligibleAfter)}, when empty`
					}
				]),
		...(shouldShowDetails(reporter) &&
		summary.earliestGraceDeadline !== undefined
			? [
					{
						label: 'Earliest grace expiry',
						value: formatTimestamp(summary.earliestGraceDeadline)
					}
				]
			: []),
		...(shouldShowDebug(reporter) && summary.graceManaged !== undefined
			? [{ label: 'Grace managed', value: summary.graceManaged ? 'yes' : 'no' }]
			: [])
	];
}

function cleanupConsequence(
	summary: Pick<CacheSummary, 'graceManaged' | 'grace'>
): string {
	if (summary.graceManaged !== true) {
		return 'Cleanup can delete paths outside the retained closure. It keeps all paths when the retained closure is empty, unless a root expired during this cleanup.';
	}

	if (summary.grace.kind === 'none') {
		return 'Eligible for deletion at the next cleanup.';
	}

	return 'Eligible for deletion after their grace periods expire.';
}

function formatRetentionDuration(seconds: number): string {
	let remaining = seconds;
	const parts: string[] = [];
	const units: readonly (readonly [number, string])[] = [
		[86_400, 'day'],
		[3600, 'hour'],
		[60, 'minute'],
		[1, 'second']
	];
	for (const [unitSeconds, unit] of units) {
		const count = Math.floor(remaining / unitSeconds);
		if (count === 0) {
			continue;
		}
		parts.push(`${formatCount(count)} ${unit}${count === 1 ? '' : 's'}`);
		remaining %= unitSeconds;
	}
	return parts.length === 0 ? '0 seconds' : parts.join(' ');
}

function rootRetentionLabel(retention: CacheRootRetention): string {
	return retention.kind === 'permanent'
		? 'permanent'
		: formatRetentionDuration(retention.seconds);
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
	return grace.kind === 'none'
		? 'none'
		: formatRetentionDuration(grace.graceSeconds);
}

function cacheCommandTarget(url: URL, name: string | undefined) {
	const urlTarget = cacheTargetFromUrl(url);

	return name === undefined ? urlTarget : cacheTargetWithName(urlTarget, name);
}

function cacheDefaultsTarget(url: URL): URL {
	const target = cacheTargetFromUrl(url);
	if (target.cache.kind !== 'default') {
		throw new CacheDefaultsTenantUrlRequiredError();
	}
	return target.tenantUrl;
}

function cacheRpc(tenantUrl: URL, programOptions: ProgramOptions) {
	return tenantRpc(tenantUrl, {
		credential: cachedOwnerProvider(tenantUrl, {
			signal: programOptions.signal
		}),
		signal: programOptions.signal
	});
}
