import { env } from 'node:process';

import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { cacheNameSchema, DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { commandUi, type ProgramOptions } from '../cli.ts';
import { InvalidCacheNameError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export interface ConfigCredential {
	readonly user: string;
	readonly password: string;
}

interface ConfigOptions {
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly cache?: string;
}

/**
 * The substituter URL for a cache: the bare URL for the default cache, or the
 * URL with a `/cache/<name>` path for a named one. The cache name is validated.
 */
export function cacheSubstituterUrl(
	url: string,
	cache: string | undefined
): string {
	if (cache === undefined || cache === DEFAULT_CACHE) {
		return url;
	}

	if (!cacheNameSchema.safeParse(cache).success) {
		throw new InvalidCacheNameError(cache);
	}

	const substituter = new URL(url);
	const basePath = substituter.pathname.replace(/\/+$/, '');
	substituter.pathname = `${basePath}/cache/${cache}`;

	return substituter.href;
}

export function runConfig(
	url: string,
	publicKey: string,
	reporter: Reporter,
	credential?: ConfigCredential
): void {
	// The nix.conf snippet is the command's payload, so it goes to stdout and
	// `cupboard config <url> <pubkey> >> nix.conf` works. The netrc lines belong in
	// a different file, so they stay on stderr as guidance.
	const nixConfig = new NixConfig(url, publicKey);
	reporter.data(nixConfig.render().trimEnd());

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

export function registerConfigCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('config')
		.description(
			"Print Nix substituter configuration suitable for a user's nix.conf."
		)
		.argument('<url>', tenantUrlArgument)
		.argument('<pubkey>', 'Nix trusted-public-keys entry')
		.option(
			'--read-user <user>',
			'private-read username (or CUPBOARD_READ_USER)'
		)
		.option(
			'--read-password <password>',
			'private-read password (or CUPBOARD_READ_PASSWORD)'
		)
		.option('--cache <name>', 'configure a named cache rather than the default')
		.action((url: string, publicKey: string, options: ConfigOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const user = options.readUser ?? env.CUPBOARD_READ_USER;
			const password = options.readPassword ?? env.CUPBOARD_READ_PASSWORD;
			const credential = user && password ? { user, password } : undefined;

			runConfig(
				cacheSubstituterUrl(url, options.cache),
				publicKey,
				reporter,
				credential
			);
		});
}
