import { env } from 'node:process';

import { cacheUrl } from '@cupboard/nix-store/cache-url';
import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { parsePublishedNixPublicKeys } from '@cupboard/nix-store/public-key';
import { type Reporter } from '@cupboard/reporter';
import type { ReadUser } from '@cupboard/shared/http';
import type { Command } from 'commander';

import { commandUi, type ProgramOptions } from '../cli.ts';
import { storedCacheFor } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseReadUser } from '../read-user.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export interface ConfigCredential {
	readonly user: ReadUser;
	readonly password: string;
}

interface ConfigOptions {
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly cache?: string;
}

/**
 * The substituter URL for a cache: the bare URL for the default cache, or the
 * URL with a `/cache/<name>` path for a named one. The cache name is validated.
 */
export function cacheSubstituterUrl(url: URL, cache: string | undefined): URL {
	return cacheUrl(url, storedCacheFor(cache));
}

export function runConfig(
	url: URL,
	publicKey: string,
	reporter: Reporter,
	credential?: ConfigCredential
): void {
	// The nix.conf snippet is the command's payload, so it goes to stdout and
	// `cupboard config <url> <pubkey> >> nix.conf` works. The netrc lines belong in
	// a different file, so they stay on stderr as guidance.
	const publishedKeys = parsePublishedNixPublicKeys(publicKey)
		.map((key) => key.value)
		.join('\n');
	const nixConfig = new NixConfig(url, publishedKeys);
	reporter.data(nixConfig.render().trimEnd());

	if (credential === undefined) {
		return;
	}

	reporter.info(
		[
			'# Private cache: add this line to your Nix netrc-file ' +
				'(e.g. ~/.config/nix/netrc):',
			renderNetrc(url, credential.user, credential.password).trimEnd()
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
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<pubkey>', 'Nix trusted-public-keys entry')
		.option(
			'--read-user <user>',
			'private-read username (or CUPBOARD_READ_USER)',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'private-read password (or CUPBOARD_READ_PASSWORD)'
		)
		.option('--cache <name>', 'configure a named cache rather than the default')
		.action((url: URL, publicKey: string, options: ConfigOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const user = options.readUser ?? parseReadUser(env.CUPBOARD_READ_USER);
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
