import { env } from 'node:process';

import { NixConfig, renderNetrc } from '@cupboard/shared';
import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { createReporter, type Reporter } from '../reporter.ts';

export interface ConfigCredential {
	readonly user: string;
	readonly password: string;
}

interface ConfigOptions {
	readonly readUser?: string;
	readonly readPassword?: string;
}

export function runConfig(
	url: string,
	publicKey: string,
	reporter: Reporter,
	credential?: ConfigCredential
): void {
	reporter.info(new NixConfig(url, publicKey).render().trimEnd());

	if (credential === undefined) {
		return;
	}

	const { hostname } = new URL(url);

	reporter.info(
		[
			'# Private cache: add this line to your Nix netrc-file ' +
				'(e.g. ~/.config/nix/netrc):',
			renderNetrc(hostname, credential.user, credential.password).trimEnd()
		].join('\n')
	);
}

export function registerConfigCommand(program: Command): void {
	program
		.command('config')
		.description(
			"Print Nix substituter configuration suitable for a user's nix.conf."
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<pubkey>', 'Nix trusted-public-keys entry')
		.option(
			'--read-user <user>',
			'private-read username (or CUPBOARD_READ_USER)'
		)
		.option(
			'--read-password <password>',
			'private-read password (or CUPBOARD_READ_PASSWORD)'
		)
		.action((url: string, publicKey: string, options: ConfigOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const user = options.readUser ?? env.CUPBOARD_READ_USER;
			const password = options.readPassword ?? env.CUPBOARD_READ_PASSWORD;
			const credential = user && password ? { user, password } : undefined;

			runConfig(url, publicKey, reporter, credential);
		});
}
