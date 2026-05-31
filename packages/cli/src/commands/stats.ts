import type { Command } from 'commander';

import { authenticate } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { createReporter, formatBytes, formatCount } from '../reporter.ts';

interface StatsOptions {
	readonly token: string;
}

export function registerStatsCommand(program: Command): void {
	program
		.command('stats')
		.description('Show cache size, object count, and recent GC summary.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.requiredOption('--token <token>', 'bootstrap secret')
		.action(async (url: string, options: StatsOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = await authenticate(client, options.token);

			const stats = await reporter.phase('Querying cupboard', () =>
				client.stats(token)
			);

			reporter.result([
				{ label: 'Store paths', value: formatCount(stats.storePaths) },
				{ label: 'NAR blobs', value: formatCount(stats.narBlobs) },
				{ label: 'Pending uploads', value: formatCount(stats.pendingUploads) },
				{ label: 'Total size', value: formatBytes(stats.totalFileSize) }
			]);
		});
}
