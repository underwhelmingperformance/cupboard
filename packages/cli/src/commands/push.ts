import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { createReporter, formatBytes, formatCount } from '../reporter.ts';

export function registerPushCommand(program: Command): void {
	program
		.command('push')
		.description(
			'Push one or more store paths to the configured cupboard cache.'
		)
		.argument('<paths...>', 'Nix store paths to push')
		.action(async (paths: string[]) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});

			await reporter.phase('Resolving store closure', (ctx) => {
				ctx.fact('roots', formatCount(paths.length));
				throw new Error('push not yet implemented');
			});

			await reporter.phase('Computing NAR hashes', (ctx) => {
				ctx.fact('paths', formatCount(0));
				throw new Error('push not yet implemented');
			});

			await reporter.phase('Negotiating with cache', (ctx) => {
				ctx.fact('missing', formatCount(0));
				throw new Error('push not yet implemented');
			});

			await reporter.phase('Compressing and uploading', (ctx) => {
				ctx.fact('uploaded', formatBytes(0));
				throw new Error('push not yet implemented');
			});

			await reporter.phase('Committing metadata', (ctx) => {
				ctx.fact('committed', formatCount(0));
				throw new Error('push not yet implemented');
			});

			reporter.result([
				{ label: 'Pushed', value: '(not yet implemented)' },
				{ label: 'Skipped', value: '(not yet implemented)' },
				{ label: 'Uploaded', value: '(not yet implemented)' }
			]);
		});
}
