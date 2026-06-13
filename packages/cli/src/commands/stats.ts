import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix/scalars';
import { createReporter, formatBytes, formatCount } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';

interface StatsOptions {
	readonly token: string;
	readonly cache?: string;
}

export function registerStatsCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('stats')
		.description('Show objects referenced by a cache.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.option('--cache <name>', 'report on a named cache rather than the default')
		.action(async (url: string, options: StatsOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url),
				signal: programOptions.signal
			});

			const stats = await reporter.phase('Querying cupboard', () =>
				rpc.stats.cache({
					cacheName: selectorForCache(options.cache ?? DEFAULT_CACHE)
				})
			);

			reporter.result({
				kind: 'cache-stats',
				data: stats,
				rows: [
					{ label: 'Store paths', value: formatCount(stats.storePaths) },
					{ label: 'Referenced NAR blobs', value: formatCount(stats.narBlobs) },
					{
						label: 'Referenced NAR size',
						value: formatBytes(stats.narFileSize)
					},
					{
						label: 'Referenced CAS objects',
						value: formatCount(stats.casObjects)
					},
					{
						label: 'Referenced CAS size',
						value: formatBytes(stats.casFileSize)
					},
					{
						label: 'Pending uploads',
						value: formatCount(stats.pendingUploads)
					},
					{
						label: 'Referenced total size',
						value: formatBytes(stats.totalFileSize)
					}
				]
			});
		});

	program
		.command('usage')
		.description('Show tenant-wide charged storage usage.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url),
				signal: programOptions.signal
			});

			const usage = await reporter.phase('Querying cupboard', () =>
				rpc.stats.usage()
			);

			reporter.result({
				kind: 'tenant-usage',
				data: usage,
				rows: [
					{ label: 'Charged NAR blobs', value: formatCount(usage.narBlobs) },
					{ label: 'Charged NAR size', value: formatBytes(usage.narFileSize) },
					{
						label: 'Charged CAS objects',
						value: formatCount(usage.casObjects)
					},
					{ label: 'Charged CAS size', value: formatBytes(usage.casFileSize) },
					{
						label: 'Charged total size',
						value: formatBytes(usage.totalFileSize)
					},
					...(usage.quotaBytes === undefined
						? []
						: [
								{
									label: 'Quota',
									value: formatBytes(usage.quotaBytes)
								},
								{
									label: 'Remaining quota',
									value: formatBytes(usage.remainingQuotaBytes ?? 0)
								}
							])
				]
			});
		});
}
