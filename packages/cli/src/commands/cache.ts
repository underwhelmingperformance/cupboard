import { CacheInfo } from '@cupboard/nix/cache-info';
import type {
	CacheListResponse,
	CacheRemoveResponse,
	CacheSummary
} from '@cupboard/protocol/caches';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client/client.ts';
import { InvalidCachePriorityError } from '../errors.ts';
import {
	createReporter,
	formatCount,
	type Reporter,
	type ResultRow
} from '../reporter.ts';

interface CacheCreateOptions {
	readonly token: string;
	readonly priority?: number;
}

interface CacheRemoveOptions {
	readonly token: string;
	readonly force?: boolean;
}

export interface CacheClient {
	listCaches(token: AccessCredential): Promise<CacheListResponse>;
	putCache(
		token: AccessCredential,
		name: string,
		priority: number
	): Promise<CacheSummary>;
	removeCache(
		token: AccessCredential,
		name: string,
		force: boolean
	): Promise<CacheRemoveResponse>;
}

function parsePriority(value: string): number {
	const priority = Number(value);

	if (!Number.isInteger(priority) || priority < 0) {
		throw new InvalidCachePriorityError(value);
	}

	return priority;
}

export function registerCacheCommands(program: Command): void {
	const cache = program
		.command('cache')
		.description('Manage named caches: list, create, inspect and tear down.');

	cache
		.command('list')
		.description('List the caches and their priority and size.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = cachedOwnerProvider(url);

			await runCacheList(token, reporter, client);
		});

	cache
		.command('create')
		.description('Create or update a named cache with the given priority.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<name>', 'cache name')
		.option(
			'--priority <n>',
			'Nix substituter priority (lower is preferred)',
			parsePriority
		)
		.action(async (url: string, name: string, options: CacheCreateOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = cachedOwnerProvider(url);

			await runCacheCreate(
				name,
				options.priority ?? CacheInfo.default.priority,
				token,
				reporter,
				client
			);
		});

	cache
		.command('remove')
		.description('Tear down a named cache.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<name>', 'cache name')
		.option('--force', 'tear down even when the cache still holds store paths')
		.action(async (url: string, name: string, options: CacheRemoveOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = cachedOwnerProvider(url);

			await runCacheRemove(
				name,
				options.force ?? false,
				token,
				reporter,
				client
			);
		});

	cache
		.command('inspect')
		.description("Show one cache's priority and size.")
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<name>', 'cache name')
		.action(async (url: string, name: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = cachedOwnerProvider(url);

			await runCacheInspect(name, token, reporter, client);
		});
}

export async function runCacheList(
	token: AccessCredential,
	reporter: Reporter,
	client: CacheClient
): Promise<void> {
	const { caches } = await reporter.phase('Listing caches', () =>
		client.listCaches(token)
	);

	reporter.result(caches.map((summary) => cacheRow(summary)));
}

export async function runCacheCreate(
	name: string,
	priority: number,
	token: AccessCredential,
	reporter: Reporter,
	client: CacheClient
): Promise<void> {
	const summary = await reporter.phase('Creating cache', () =>
		client.putCache(token, name, priority)
	);

	reporter.result(summaryRows(summary));
}

export async function runCacheRemove(
	name: string,
	force: boolean,
	token: AccessCredential,
	reporter: Reporter,
	client: CacheClient
): Promise<void> {
	const result = await reporter.phase('Removing cache', () =>
		client.removeCache(token, name, force)
	);

	reporter.result([
		{ label: 'Cache', value: cacheLabel(result.name) },
		{ label: 'Removed', value: result.removed ? 'yes' : 'not present' },
		{
			label: 'Store paths removed',
			value: formatCount(result.storePathsRemoved)
		}
	]);
}

export async function runCacheInspect(
	name: string,
	token: AccessCredential,
	reporter: Reporter,
	client: CacheClient
): Promise<void> {
	const { caches } = await reporter.phase('Inspecting cache', () =>
		client.listCaches(token)
	);
	const summary = caches.find((candidate) => candidate.name === name);

	if (summary === undefined) {
		reporter.info(`No cache named ${name}.`);
		return;
	}

	reporter.result(summaryRows(summary));
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
