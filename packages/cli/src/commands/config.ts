import { NixConfig } from '@cupboard/shared';
import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { createReporter, type Reporter } from '../reporter.ts';

export function runConfig(
	url: string,
	publicKey: string,
	reporter: Reporter
): void {
	reporter.info(new NixConfig(url, publicKey).render().trimEnd());
}

export function registerConfigCommand(program: Command): void {
	program
		.command('config')
		.description(
			"Print Nix substituter configuration suitable for a user's nix.conf."
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<pubkey>', 'Nix trusted-public-keys entry')
		.action((url: string, publicKey: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			runConfig(url, publicKey, reporter);
		});
}
