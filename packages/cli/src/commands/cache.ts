import type { CliUi } from '@cupboard/cli-ui';
import { CacheInfo } from '@cupboard/nix/cache-info';
import type {
	CacheListResponse,
	CacheRemoveResponse,
	CacheSummary
} from '@cupboard/protocol/caches';
import { formatCount, type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { InvalidCachePriorityError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface CacheCreateOptions {
	readonly priority?: number;
}

interface CacheRemoveOptions {
	readonly force?: boolean;
	readonly yes?: boolean;
}

/**
 * The slice of the derived client the cache commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).caches`
 * satisfies it by construction.
 */
export interface CacheClient {
	list(): Promise<CacheListResponse>;
	put(input: { cacheName: string; priority: number }): Promise<CacheSummary>;
	remove(input: {
		params: { cacheName: string };
		query?: { force?: boolean };
	}): Promise<CacheRemoveResponse>;
}

function parsePriority(value: string): number {
	const priority = Number(value);

	if (!Number.isSafeInteger(priority) || priority < 0) {
		throw new InvalidCachePriorityError(value);
	}

	return priority;
}

export function registerCacheCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const cache = program
		.command('cache')
		.description('Manage named caches: list, create, inspect and remove.');

	cache
		.command('list')
		.description('List the caches and their priority and size.')
		.argument('<url>', tenantUrlArgument)
		.action(async (url: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runCacheList(reporter, rpc.caches);
		});

	cache
		.command('create')
		.description('Create or update a named cache with the given priority.')
		.argument('<url>', tenantUrlArgument)
		.argument('<name>', 'cache name')
		.option(
			'--priority <n>',
			'Nix substituter priority (lower is preferred)',
			parsePriority
		)
		.action(async (url: string, name: string, options: CacheCreateOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runCacheCreate(
				name,
				options.priority ?? CacheInfo.default.priority,
				reporter,
				rpc.caches
			);
		});

	cache
		.command('remove')
		.description('Remove a named cache.')
		.argument('<url>', tenantUrlArgument)
		.argument('<name>', 'cache name')
		.option('--force', 'remove even when the cache still holds store paths')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: string, name: string, options: CacheRemoveOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runCacheRemove(name, options.force ?? false, ui, rpc.caches);
		});

	cache
		.command('inspect')
		.description("Show one cache's priority and size.")
		.argument('<url>', tenantUrlArgument)
		.argument('<name>', 'cache name')
		.action(async (url: string, name: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runCacheInspect(name, reporter, rpc.caches);
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
	name: string,
	priority: number,
	reporter: Reporter,
	client: Pick<CacheClient, 'put'>
): Promise<void> {
	const summary = await reporter.phase('Creating cache', () =>
		client.put({ cacheName: name, priority })
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
		message: `Remove cache ${cacheLabel(name)}?`,
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
			{ label: 'Cache', value: cacheLabel(result.name) },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' },
			{
				label: 'Store paths removed',
				value: formatCount(result.storePathsRemoved)
			}
		]
	});
}

export async function runCacheInspect(
	name: string,
	reporter: Reporter,
	client: Pick<CacheClient, 'list'>
): Promise<void> {
	const { caches } = await reporter.phase('Inspecting cache', () =>
		client.list()
	);
	const summary = caches.find((candidate) => candidate.name === name);

	if (summary === undefined) {
		reporter.info(`No cache named ${name}.`);
		return;
	}

	reporter.result({ kind: 'cache', data: summary, rows: summaryRows(summary) });
}

function cacheRow(summary: CacheSummary): ResultRow {
	return {
		label: cacheLabel(summary.name),
		value: `priority ${String(summary.priority)}; ${formatCount(summary.storePaths)} path(s)`
	};
}

function summaryRows(summary: CacheSummary): ResultRow[] {
	return [
		{ label: 'Cache', value: cacheLabel(summary.name) },
		{ label: 'Priority', value: String(summary.priority) },
		{ label: 'Store paths', value: formatCount(summary.storePaths) }
	];
}

function cacheLabel(name: string): string {
	return name === '' ? '(default)' : name;
}
