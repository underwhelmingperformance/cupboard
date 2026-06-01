import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { createReporter, formatBytes, formatCount } from '../reporter.ts';

interface StatsOptions {
	readonly token: string;
	readonly cache?: string;
}

interface UsageOptions {
	readonly token: string;
}

export function registerStatsCommand(program: Command): void {
	program
		.command('stats')
		.description('Show objects referenced by a cache.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.option('--cache <name>', 'report on a named cache rather than the default')
		.action(async (url: string, options: StatsOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url, options.cache);
			const token = cachedOwnerProvider();

			const stats = await reporter.phase('Querying cupboard', () =>
				client.stats(token)
			);

			reporter.result([
				{ label: 'Store paths', value: formatCount(stats.storePaths) },
				{ label: 'Referenced NAR blobs', value: formatCount(stats.narBlobs) },
				{ label: 'Referenced NAR size', value: formatBytes(stats.narFileSize) },
				{
					label: 'Referenced CAS objects',
					value: formatCount(stats.casObjects)
				},
				{ label: 'Referenced CAS size', value: formatBytes(stats.casFileSize) },
				{ label: 'Pending uploads', value: formatCount(stats.pendingUploads) },
				{
					label: 'Referenced total size',
					value: formatBytes(stats.totalFileSize)
				}
			]);
		});

	program
		.command('usage')
		.description('Show tenant-wide charged storage usage.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.requiredOption('--token <token>', 'bootstrap secret')
		.action(async (url: string, options: UsageOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = await authenticate(client, options.token);

			const usage = await reporter.phase('Querying cupboard', () =>
				client.usage(token)
			);

			reporter.result([
				{ label: 'Charged NAR blobs', value: formatCount(usage.narBlobs) },
				{ label: 'Charged NAR size', value: formatBytes(usage.narFileSize) },
				{ label: 'Charged CAS objects', value: formatCount(usage.casObjects) },
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
			]);
		});
}
