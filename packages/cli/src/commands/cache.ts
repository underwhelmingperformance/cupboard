import type { CliUi } from '@cupboard/cli-ui';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	type CachePriority,
	cachePrioritySchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import type {
	CacheListResponse,
	CacheRemoveResponse,
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

import { cachedOwnerProvider } from '../auth/auth.ts';
import { parseCacheAccess } from '../cache-access.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { cacheLabel } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { isRpcNotFoundError } from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	InvalidCachePriorityError,
	NamedCacheTargetRequiredError
} from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface CacheCreateOptions {
	readonly access?: CacheAccessMode;
	readonly priority?: CachePriority;
}

interface CacheSetAccessOptions {
	readonly access: CacheAccessMode;
}

interface CacheSetPriorityOptions {
	readonly priority: CachePriority;
}

interface CacheRemoveOptions {
	readonly force?: boolean;
	readonly yes?: boolean;
}

export interface CacheClient {
	list(): Promise<CacheListResponse>;
	get: CacheScopedClient<Record<never, never>, CacheSummary>;
	put: CacheScopedClient<
		{
			access: CacheAccessMode;
			priority: number;
		},
		CacheSummary
	>;
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
		.description('List the caches, their priority and their store-path count.')
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
		.option(
			'--access <mode>',
			'read access: public or private',
			parseCacheAccess
		)
		.option(
			'--priority <n>',
			'Nix substituter priority (lower is preferred)',
			parsePriority
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
					reporter,
					rpc.caches
				);
			}
		);

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
		.description("Show one cache's priority and store-path count.")
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
	reporter: Reporter,
	client: Pick<CacheClient, 'put'>
): Promise<void> {
	const summary = await reporter.phase('Creating cache', () =>
		callInCache(client.put, cache, {
			access,
			priority
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
		`${formatCount(summary.storePaths)} path(s)`
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
		{ label: 'Store paths', value: formatCount(summary.storePaths) }
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
