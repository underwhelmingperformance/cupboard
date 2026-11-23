import { env } from 'node:process';

import { cacheUrl, urlWithCredential } from '@cupboard/nix-store/cache-url';
import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { parsePublishedNixPublicKeys } from '@cupboard/nix-store/public-key';
import { type CacheScope, isSameCacheScope } from '@cupboard/nix-store/scalars';
import { type AccessKeySecret } from '@cupboard/protocol/access-keys';
import {
	type CacheAccessKeys,
	cacheAccessKeysSchema
} from '@cupboard/protocol/cache-access-keys';
import type { Reporter } from '@cupboard/reporter';
import type { BasicCredential } from '@cupboard/shared/http';
import type { Command } from 'commander';

import {
	accessKeyFor,
	basicCredentialForAccessKey,
	parseAccessKey
} from '../access-key-options.ts';
import {
	type CacheTarget,
	cacheTargetFromUrl,
	cacheTargetWithName
} from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	InvalidCacheAccessKeysError,
	UnknownCacheAccessKeyError
} from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export interface ConfigSubstituter {
	readonly cache: CacheScope;
	readonly credential?: BasicCredential;
}

export interface ConfigInput {
	readonly url: URL;
	readonly publicKey: string;
	readonly substituters: readonly ConfigSubstituter[];
	readonly netrcCredential?: BasicCredential;
}

interface ConfigOptions {
	readonly accessKey?: AccessKeySecret;
	readonly cacheAccessKeys?: string;
	readonly includeDefaultCache?: boolean;
}

const defaultCacheScope: CacheScope = { kind: 'default' };

/**
Returns the substituter URL for one cache and optional credential.
*/
export function cacheSubstituterUrl(
	url: URL,
	cache: CacheScope,
	credential?: BasicCredential
): URL {
	const substituter = cacheUrl(url, cache);

	return credential === undefined
		? substituter
		: urlWithCredential(substituter, credential);
}

export function runConfig(input: ConfigInput, reporter: Reporter): void {
	// The nix.conf snippet is the command's payload, so it goes to stdout and
	// `cupboard config <url> <pubkey> >> nix.conf` works. The netrc lines belong
	// in a different file, so they stay on stderr as guidance.
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
				"# Add this line to the file configured by Nix's netrc-file setting:",
				'# Check its path with: nix config show netrc-file',
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
				'# A substituter URL above contains a cache-specific access key.',
				'# Keep this snippet as secret as the access key itself.'
			].join('\n')
		);
	}
}

export function parseCacheAccessKeys(
	value: string | undefined
): CacheAccessKeys {
	if (value === undefined || value.trim() === '') {
		return [];
	}

	let document: unknown;

	try {
		document = JSON.parse(value);
	} catch (error) {
		throw new InvalidCacheAccessKeysError({ cause: error });
	}

	const parsed = cacheAccessKeysSchema.safeParse(document);

	if (!parsed.success) {
		throw new InvalidCacheAccessKeysError({ cause: parsed.error });
	}

	return parsed.data;
}

export function resolveConfigSubstituters(
	selected: readonly CacheScope[],
	accessKeys: CacheAccessKeys
): readonly ConfigSubstituter[] {
	for (const entry of accessKeys) {
		if (selected.some((cache) => isSameCacheScope(cache, entry.cache))) {
			continue;
		}

		throw new UnknownCacheAccessKeyError(cacheDescription(entry.cache));
	}

	return selected.map((cache) => {
		const accessKey = accessKeys.find((entry) =>
			isSameCacheScope(entry.cache, cache)
		)?.accessKey;

		return {
			cache,
			...(accessKey !== undefined && {
				credential: basicCredentialForAccessKey(accessKey)
			})
		};
	});
}

/**
Selects named caches from the positional arguments, or the URL's cache when
no names are given. With `hasDefaultCache`, the default cache comes first
and appears once, separately from any named cache called `default`.
*/
export function selectConfigCaches(
	target: CacheTarget,
	names: readonly string[],
	hasDefaultCache: boolean
): readonly CacheScope[] {
	const selected =
		names.length === 0
			? [target.cache]
			: names.map((name) => cacheTargetWithName(target, name).cache);

	if (!hasDefaultCache) {
		return selected;
	}

	return [
		defaultCacheScope,
		...selected.filter((cache) => cache.kind !== 'default')
	];
}

export function registerConfigCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('config')
		.description(
			"Print the nix.conf lines that add a tenant's caches as Nix substituters."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<pubkey>',
			"the tenant's public signing keys, as printed by `cupboard pubkey`"
		)
		.argument(
			'[caches...]',
			'named caches to add (by default, the cache that the URL refers to)'
		)
		.option(
			'--include-default-cache',
			"also add the tenant's default cache when you name caches"
		)
		.option(
			'--access-key <key>',
			'access key for private caches, printed as a netrc line (default: $CUPBOARD_ACCESS_KEY)',
			parseAccessKey
		)
		.option(
			'--cache-access-keys <json>',
			'an access key for each of several caches, as a JSON array of caches and keys, written into the substituter URLs (default: $CUPBOARD_CACHE_ACCESS_KEYS)'
		)
		.action(
			(
				url: URL,
				publicKey: string,
				names: string[],
				options: ConfigOptions
			) => {
				const reporter = commandUi(program, programOptions).reporter();
				const sharedKey = accessKeyFor(options);
				const shared =
					sharedKey === undefined
						? undefined
						: basicCredentialForAccessKey(sharedKey);
				const credentials = parseCacheAccessKeys(
					options.cacheAccessKeys ?? env.CUPBOARD_CACHE_ACCESS_KEYS
				);
				const target = cacheTargetFromUrl(url);
				const selected = selectConfigCaches(
					target,
					names,
					options.includeDefaultCache === true
				);

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

function cacheDescription(cache: CacheScope): string {
	return cache.kind === 'default' ? 'the default cache' : cache.name;
}
