import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { createReporter } from '../reporter.ts';

export function registerStatsCommand(program: Command): void {
	program
		.command('stats')
		.description('Show cache size, object count, and recent GC summary.')
		.action(async () => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});

			await reporter.phase('Querying cupboard', () => {
				throw new Error('stats not yet implemented');
			});

			reporter.result([
				{ label: 'Store paths', value: '(not yet implemented)' },
				{ label: 'NAR blobs', value: '(not yet implemented)' },
				{ label: 'Total size', value: '(not yet implemented)' }
			]);
		});
}
