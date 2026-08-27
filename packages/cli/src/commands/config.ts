import { env } from 'node:process';

import { cacheUrl, urlWithCredential } from '@cupboard/nix-store/cache-url';
import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { parsePublishedNixPublicKeys } from '@cupboard/nix-store/public-key';
import {
	type CacheName,
	DEFAULT_CACHE,
	privateStoredCache,
	type StoredCache
} from '@cupboard/nix-store/scalars';
import {
	type PrivateCacheCredentials,
	privateCacheCredentialsSchema
} from '@cupboard/protocol/private-cache-credentials';
import { type Reporter } from '@cupboard/reporter';
import type { ReadUser } from '@cupboard/shared/http';
import { type Command, Option } from 'commander';

import { commandUi, type ProgramOptions } from '../cli.ts';
import { cacheNameFor, storedCacheFor } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	InvalidPrivateCacheCredentialsError,
	PrivateCacheCredentialRequiredError,
	UnknownPrivateCacheCredentialError
} from '../errors.ts';
import { parseReadUser } from '../read-user.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export interface ConfigCredential {
	readonly user: ReadUser;
	readonly password: string;
}

/**
 * A cache to configure and its optional read credential. Private caches provide
 * a credential because every read requires authentication. Public caches omit
 * it.
 */
export interface ConfigSubstituter {
	readonly cache: StoredCache;
	readonly credential?: ConfigCredential;
}

export interface ConfigInput {
	readonly url: URL;
	readonly publicKey: string;
	readonly substituters: readonly ConfigSubstituter[];
	/**
	 * The tenant-wide read credential, printed as netrc guidance. A
	 * cache-specific credential appears in the private-cache substituter URL
	 * instead.
	 */
	readonly netrcCredential?: ConfigCredential;
}

/**
 * A cache selected on the command line and the position of its option.
 * Commander accumulates `--cache` and `--private-cache` separately, so this
 * position preserves the order of the original arguments.
 */
interface SelectedCache {
	readonly isPrivate: boolean;
	readonly name: string;
	readonly position: number;
}

interface ConfigOptions {
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly privateCacheCredentials?: string;
	readonly cache: readonly SelectedCache[];
	readonly privateCache: readonly SelectedCache[];
}

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Returns the substituter URL for one cache: the bare tenant URL for the default
 * cache, a `/cache/<name>` path for a named public cache, and a
 * `/private-cache/<name>` path for a private one.
 *
 * A private-cache URL contains its read credential. Nix reads a netrc entry by
 * host, so netrc cannot select one cache on that host. Curl prefers the URL
 * credential to any netrc entry for the same host.
 */
export function cacheSubstituterUrl(
	url: URL,
	cache: StoredCache,
	credential?: ConfigCredential
): URL {
	const substituter = cacheUrl(url, cache);

	return credential === undefined
		? substituter
		: urlWithCredential(substituter, credential);
}

export function runConfig(input: ConfigInput, reporter: Reporter): void {
	// The nix.conf snippet is the command's payload, so it goes to stdout and
	// `cupboard config <url> <pubkey> >> nix.conf` works. The netrc lines belong in
	// a different file, so they stay on stderr as guidance.
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
				'# Private tenant: add this line to your Nix netrc-file ' +
					'(e.g. ~/.config/nix/netrc):',
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
				'# Every private-cache read requires authentication. The substituter ' +
					'URL above contains its read credential.',
				'# Keep this snippet as secret as the credential itself.'
			].join('\n')
		);
	}
}

/**
 * Reads private-cache credentials from `--private-cache-credentials` or
 * `CUPBOARD_PRIVATE_CACHE_CREDENTIALS`. The value is a JSON object that maps
 * each private cache's local name to its read credential. An absent or blank
 * value returns an empty map.
 */
export function parsePrivateCacheCredentials(
	value: string | undefined
): PrivateCacheCredentials {
	if (value === undefined || value.trim() === '') {
		return new Map();
	}

	let document: unknown;

	try {
		document = JSON.parse(value);
	} catch (error) {
		throw new InvalidPrivateCacheCredentialsError({ cause: error });
	}

	const parsed = privateCacheCredentialsSchema.safeParse(document);

	if (!parsed.success) {
		throw new InvalidPrivateCacheCredentialsError({ cause: parsed.error });
	}

	return parsed.data;
}

/**
 * Resolves the selected caches and the read credential for each private cache.
 * The command fails if a private cache has neither a cache-specific credential
 * nor the shared credential.
 *
 * Every credential-map key must match a selected private cache.
 */
export function resolveConfigSubstituters(
	selected: readonly SelectedCache[],
	shared: ConfigCredential | undefined,
	credentials: PrivateCacheCredentials
): readonly ConfigSubstituter[] {
	const privateNames = new Set(
		selected.filter((entry) => entry.isPrivate).map((entry) => entry.name)
	);

	for (const name of credentials.keys()) {
		if (!privateNames.has(name)) {
			throw new UnknownPrivateCacheCredentialError(name);
		}
	}

	if (selected.length === 0) {
		return [{ cache: DEFAULT_CACHE }];
	}

	return selected
		.toSorted((left, right) => left.position - right.position)
		.map((entry) => {
			if (!entry.isPrivate) {
				return { cache: storedCacheFor(entry.name) };
			}

			const name = cacheNameFor(entry.name);

			return {
				cache: privateStoredCache(name),
				credential: privateCacheCredential(name, shared, credentials)
			};
		});
}

function privateCacheCredential(
	name: CacheName,
	shared: ConfigCredential | undefined,
	credentials: PrivateCacheCredentials
): ConfigCredential {
	const credential = credentials.get(name) ?? shared;

	if (credential === undefined) {
		throw new PrivateCacheCredentialRequiredError(name);
	}

	return credential;
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

/**
 * Accumulates one selected cache and records its position among both repeatable
 * options. Commander stores `--cache` and `--private-cache` in separate lists,
 * so the position restores the order of the original arguments.
 */
function collectCache(
	isPrivate: boolean,
	command: Command
): (name: string, previous: readonly SelectedCache[]) => SelectedCache[] {
	return (name, previous) => {
		const options = command.opts<ConfigOptions>();

		return [
			...previous,
			{
				isPrivate,
				name,
				position: options.cache.length + options.privateCache.length
			}
		];
	};
}

/**
 * Registers the two repeatable cache-selection options. Unlike a single-target
 * command, `config` accepts both together and prints one snippet for all
 * selected caches.
 */
export function addConfigCacheOptions(command: Command): Command {
	return command
		.addOption(
			new Option(
				'--cache <name>',
				'Add a named public cache. Repeat this option to add more public ' +
					'caches.'
			)
				.argParser(collectCache(false, command))
				.default([])
		)
		.addOption(
			new Option(
				'--private-cache <name>',
				'Add a private cache. Supply its credential through ' +
					'--private-cache-credentials or through --read-user and ' +
					'--read-password. Repeat this option to add more private caches.'
			)
				.argParser(collectCache(true, command))
				.default([])
		);
}

export function registerConfigCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const config = program
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
		.option(
			'--private-cache-credentials <json>',
			'JSON object mapping a private cache name to its user and password ' +
				'(or CUPBOARD_PRIVATE_CACHE_CREDENTIALS)'
		);

	addConfigCacheOptions(config)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # One snippet covering a public cache and a private one',
				'  cupboard config https://cupboard.example.workers.dev/t/acme "$pubkey" \\',
				'    --cache builds --private-cache release'
			].join('\n')
		)
		.action((url: URL, publicKey: string, options: ConfigOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const shared = sharedCredential(options, env);
			const credentials = parsePrivateCacheCredentials(
				options.privateCacheCredentials ??
					env.CUPBOARD_PRIVATE_CACHE_CREDENTIALS
			);
			const substituters = resolveConfigSubstituters(
				[...options.cache, ...options.privateCache],
				shared,
				credentials
			);

			runConfig(
				{
					url,
					publicKey,
					substituters,
					...(shared !== undefined && { netrcCredential: shared })
				},
				reporter
			);
		});
}
