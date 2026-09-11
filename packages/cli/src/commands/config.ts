import { env } from 'node:process';

import { cacheUrl, urlWithCredential } from '@cupboard/nix-store/cache-url';
import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { parsePublishedNixPublicKeys } from '@cupboard/nix-store/public-key';
import { type CacheScope, isSameCacheScope } from '@cupboard/nix-store/scalars';
import {
	type CacheCredentials,
	cacheCredentialsSchema
} from '@cupboard/protocol/cache-credentials';
import type { Reporter } from '@cupboard/reporter';
import type { ReadUser } from '@cupboard/shared/http';
import type { Command } from 'commander';

import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	InvalidCacheCredentialsError,
	UnknownCacheCredentialError
} from '../errors.ts';
import { parseReadUser } from '../read-user.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export interface ConfigCredential {
	readonly user: ReadUser;
	readonly password: string;
}

export interface ConfigSubstituter {
	readonly cache: CacheScope;
	readonly credential?: ConfigCredential;
}

export interface ConfigInput {
	readonly url: URL;
	readonly publicKey: string;
	readonly substituters: readonly ConfigSubstituter[];
	readonly netrcCredential?: ConfigCredential;
}

interface ConfigOptions {
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly cacheCredentials?: string;
}

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Returns the substituter URL for one cache and optional credential.
 */
export function cacheSubstituterUrl(
	url: URL,
	cache: CacheScope,
	credential?: ConfigCredential
): URL {
	const substituter = cacheUrl(url, cache);

	return credential === undefined
		? substituter
		: urlWithCredential(substituter, credential);
}

export function runConfig(input: ConfigInput, reporter: Reporter): void {
	const publishedKeys = parsePublishedNixPublicKeys(input.publicKey)
		.map((key) => key.value)
		.join('\n');
	const substituters = input.substituters.map((substituter) =>
		cacheSubstituterUrl(input.url, substituter.cache, substituter.credential)
	);
	const nixConfig = new NixConfig(substituters, publishedKeys);

	reporter.data(nixConfig.render().trimEnd());

	if (input.netrcCredential !== undefined) {
		reporter.info(
			[
				'# Add this line to your Nix netrc-file (for example, ~/.config/nix/netrc):',
				renderNetrc(
					input.url,
					input.netrcCredential.user,
					input.netrcCredential.password
				).trimEnd()
			].join('\n')
		);
	}

	if (input.substituters.some((entry) => entry.credential !== undefined)) {
		reporter.info(
			[
				'# A substituter URL above contains a cache-specific read credential.',
				'# Keep this snippet as secret as the credential itself.'
			].join('\n')
		);
	}
}

export function parseCacheCredentials(
	value: string | undefined
): CacheCredentials {
	if (value === undefined || value.trim() === '') {
		return [];
	}

	let document: unknown;

	try {
		document = JSON.parse(value);
	} catch (error) {
		throw new InvalidCacheCredentialsError({ cause: error });
	}

	const parsed = cacheCredentialsSchema.safeParse(document);

	if (!parsed.success) {
		throw new InvalidCacheCredentialsError({ cause: parsed.error });
	}

	return parsed.data;
}

export function resolveConfigSubstituters(
	selected: readonly CacheScope[],
	credentials: CacheCredentials
): readonly ConfigSubstituter[] {
	for (const entry of credentials) {
		if (selected.some((cache) => isSameCacheScope(cache, entry.cache))) {
			continue;
		}

		throw new UnknownCacheCredentialError(cacheDescription(entry.cache));
	}

	return selected.map((cache) => {
		const credential = credentials.find((entry) =>
			isSameCacheScope(entry.cache, cache)
		)?.credential;

		return {
			cache,
			...(credential !== undefined && { credential })
		};
	});
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
		.argument('[caches...]', 'named caches; omit them to use the URL target')
		.option(
			'--read-user <user>',
			'read username (or CUPBOARD_READ_USER)',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'read password (or CUPBOARD_READ_PASSWORD)'
		)
		.option(
			'--cache-credentials <json>',
			'JSON array of cache scopes and their credentials (or CUPBOARD_CACHE_CREDENTIALS)'
		)
		.action(
			(
				url: URL,
				publicKey: string,
				names: string[],
				options: ConfigOptions
			) => {
				const reporter = commandUi(program, programOptions).reporter();
				const shared = sharedCredential(options, env);
				const credentials = parseCacheCredentials(
					options.cacheCredentials ?? env.CUPBOARD_CACHE_CREDENTIALS
				);
				const target = cacheTargetFromUrl(url);
				const selected =
					names.length === 0
						? [target.cache]
						: names.map((name) => cacheTargetWithName(target, name).cache);

				runConfig(
					{
						url: target.tenantUrl,
						publicKey,
						substituters: resolveConfigSubstituters(selected, credentials),
						...(shared !== undefined && { netrcCredential: shared })
					},
					reporter
				);
			}
		);
}

function sharedCredential(
	options: ConfigOptions,
	environment: ConfigEnvironment
): ConfigCredential | undefined {
	const user =
		options.readUser ?? parseReadUser(environment.CUPBOARD_READ_USER);
	const password = options.readPassword ?? environment.CUPBOARD_READ_PASSWORD;

	return user !== undefined && password !== undefined
		? { user, password }
		: undefined;
}

function cacheDescription(cache: CacheScope): string {
	return cache.kind === 'default' ? 'the default cache' : cache.name;
}
