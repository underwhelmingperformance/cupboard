import { readFile } from 'node:fs/promises';
import { constants as signalNumbers } from 'node:os';
import process from 'node:process';

import {
	discoverNixStoreConfig,
	netrcCredentialFor,
	type NixStoreConfig
} from '@cupboard/nix';
import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';
import { isSameCacheScope } from '@cupboard/nix-store/scalars';
import {
	readAccessFileEnvironment,
	type ReadResource,
	readResourcesSchema
} from '@cupboard/protocol/read-access';
import {
	type ReuseViewName,
	reuseViewNameSchema
} from '@cupboard/protocol/reuse-views';
import { type BasicCredential, readUserSchema } from '@cupboard/shared/http';
import { type Command, InvalidArgumentError } from 'commander';

import { throwIfAborted } from '../abort.ts';
import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import {
	issueGithubReadCredential,
	type IssueGithubReadCredentialInput
} from '../auth/github-read-credential.ts';
import {
	type ReadCredentialLease,
	type ReadCredentialSessionOptions,
	withRenewingReadCredential
} from '../auth/read-credential-session.ts';
import { childExitCode } from '../build-push/build-push.ts';
import {
	type ChildCommand,
	type ChildExit,
	type RunChild,
	runChild
} from '../build-push/supervisor.ts';
import type { CacheTarget } from '../cache-target.ts';
import { cacheTargetFromUrl } from '../cache-target.ts';
import type { ProgramOptions } from '../cli.ts';
import { parseWorkerUrl, resilientFetcher } from '../client/transport.ts';
import { CliError, CliUsageError } from '../errors.ts';

interface RunOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly reuseView?: ReuseViewName;
	readonly cacheMetadata?: boolean;
	readonly readCache?: readonly CacheTarget[];
	readonly readCacheMetadata?: readonly CacheTarget[];
}

interface ViewTarget {
	readonly tenantUrl: URL;
	readonly view: ReuseViewName;
}

type ReadTarget = CacheTarget | ViewTarget;

export interface RunReadAccessDependencies {
	readonly environment?: NodeJS.ProcessEnv;
	readonly storeConfig?: NixStoreConfig;
	readonly readFile?: (file: string, encoding: 'utf8') => Promise<string>;
	readonly fetcher?: typeof fetch;
	readonly issue?: (
		input: IssueGithubReadCredentialInput
	) => Promise<ReadCredentialLease>;
	readonly runChild?: RunChild;
	readonly signal?: AbortSignal;
	readonly renewal?: Pick<
		ReadCredentialSessionOptions,
		'now' | 'wait' | 'renewalMarginMs' | 'safetyMarginMs' | 'retryDelayMs'
	>;
}

export class RunReadAccessOptionsError extends CliUsageError {
	constructor(message: string) {
		super(message);
		this.name = 'RunReadAccessOptionsError';
	}
}

export class UnreadableReadCredentialFileError extends CliError {
	constructor(file: string) {
		super(
			`Cannot preserve credentials from the configured Nix netrc at ${file}. Make the file readable before requesting temporary read access.`
		);
		this.name = 'UnreadableReadCredentialFileError';
	}
}

export class RunExecutableNotFoundError extends CliError {
	constructor(
		readonly executable: string,
		options: ErrorOptions
	) {
		super(
			`Command executable '${executable}' was not found. Install it or pass its full path.`,
			options
		);
		this.name = 'RunExecutableNotFoundError';
	}

	override get exitCode(): number {
		return 127;
	}
}

export class RunCommandFailedError extends CliError {
	constructor(
		readonly status: number | undefined,
		readonly signal: NodeJS.Signals | undefined
	) {
		super(
			signal === undefined
				? `Command exited with status ${String(status)}`
				: `Command was terminated by ${signal}`
		);
		this.name = 'RunCommandFailedError';
	}

	override get exitCode(): number {
		return (
			this.status ??
			(this.signal === undefined ? 1 : 128 + signalNumbers.signals[this.signal])
		);
	}
}

export async function runWithReadAccess(
	target: ReadTarget,
	command: ChildCommand,
	options: RunOptions,
	dependencies: RunReadAccessDependencies = {}
): Promise<void> {
	const environment = dependencies.environment ?? process.env;

	if (options.githubOidc !== true) {
		if (
			options.audience !== undefined ||
			options.reuseView !== undefined ||
			options.cacheMetadata === true ||
			(options.readCache?.length ?? 0) > 0 ||
			(options.readCacheMetadata?.length ?? 0) > 0
		) {
			throw new RunReadAccessOptionsError(
				'--audience, --reuse-view, --cache-metadata, --read-cache and --read-cache-metadata require --github-oidc.'
			);
		}
		await runOwnedChild(command, environment, dependencies);

		return;
	}

	const additionalCaches = [
		...(options.readCache ?? []).map((target) => ({
			target,
			mode: 'content' as const
		})),
		...(options.readCacheMetadata ?? []).map((target) => ({
			target,
			mode: 'metadata' as const
		}))
	];
	for (const { target: additional } of additionalCaches) {
		if (additional.tenantUrl.href !== target.tenantUrl.href) {
			throw new RunReadAccessOptionsError(
				'Additional read caches must belong to the same tenant as the selected cache or view. Run separate commands for other tenants.'
			);
		}
	}

	const storeConfig = dependencies.storeConfig ?? discoverNixStoreConfig();
	for (const configured of storeConfig.substitution.substituters) {
		if (!URL.canParse(configured)) {
			continue;
		}
		const url = new URL(configured);
		if (
			url.hostname !== target.tenantUrl.hostname ||
			(url.username !== '' && url.password !== '')
		) {
			continue;
		}
		const tenantPath = /^(.*\/t\/[^/]+)(?:\/|$)/u.exec(url.pathname)?.[1];
		if (
			tenantPath !== undefined &&
			tenantPath !== target.tenantUrl.pathname.replace(/\/$/u, '')
		) {
			throw new RunReadAccessOptionsError(
				'A configured substituter belongs to a different tenant on the same host. Nix netrc credentials apply to a whole host. Supply complete URL credentials for the substituter of the other tenant, or use separate commands and Nix configurations.'
			);
		}
	}
	const fetcher = resilientFetcher('replay-safe', dependencies.fetcher);
	const cache = 'cache' in target ? target.cache : undefined;
	const targetUrl =
		cache === undefined ? undefined : cacheUrl(target.tenantUrl, cache);
	const viewName = 'view' in target ? target.view : options.reuseView;
	const viewUrl =
		viewName === undefined
			? undefined
			: reuseViewUrl(target.tenantUrl, viewName);
	let configuredNetrc: string | undefined;
	let isNetrcUnreadable = false;
	try {
		configuredNetrc = await readConfiguredNetrc(
			storeConfig.fileTransfer.netrcFile,
			dependencies.readFile ?? readFile
		);
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			(error.code === 'EACCES' || error.code === 'EPERM')
		) {
			isNetrcUnreadable = true;
		} else {
			throw error;
		}
	}

	if (isNetrcUnreadable) {
		throw new UnreadableReadCredentialFileError(
			storeConfig.fileTransfer.netrcFile
		);
	}

	const cacheCredential =
		targetUrl === undefined
			? undefined
			: staticCredentialFor(
					targetUrl,
					storeConfig.substitution.substituters,
					configuredNetrc
				);
	const requiresCacheOidc = targetUrl !== undefined;
	const requiresViewOidc = viewUrl !== undefined;

	const issue = dependencies.issue ?? issueGithubReadCredential;
	const resources: ReadResource[] = [
		...(requiresCacheOidc && cache !== undefined
			? [
					{
						type: 'cupboard_cache' as const,
						cache,
						mode:
							options.cacheMetadata === true
								? ('metadata' as const)
								: ('content' as const)
					}
				]
			: []),
		...additionalCaches.flatMap(({ target: additional, mode }, index, all) => {
			if (
				(cache !== undefined && isSameCacheScope(additional.cache, cache)) ||
				all
					.slice(0, index)
					.some((previous) =>
						isSameCacheScope(previous.target.cache, additional.cache)
					)
			) {
				return [];
			}
			return [
				{
					type: 'cupboard_cache' as const,
					cache: additional.cache,
					mode
				}
			];
		}),
		...(requiresViewOidc && viewName !== undefined
			? [{ type: 'cupboard_view' as const, view: viewName }]
			: [])
	];

	const parsedResources = readResourcesSchema.safeParse(resources);
	if (!parsedResources.success) {
		throw new RunReadAccessOptionsError(
			'A read session accepts up to sixteen distinct resources, including at most one reuse view.'
		);
	}

	for (const resource of resources) {
		if (resource.type === 'cupboard_cache' && resource.mode === 'metadata') {
			continue;
		}

		const resourceUrl =
			resource.type === 'cupboard_cache'
				? cacheUrl(target.tenantUrl, resource.cache)
				: reuseViewUrl(target.tenantUrl, resource.view);
		if (
			staticCredentialFor(
				resourceUrl,
				storeConfig.substitution.substituters,
				undefined
			) !== undefined
		) {
			throw new RunReadAccessOptionsError(
				'Remove explicit substituter URL credentials for every resource requested with OIDC content access.'
			);
		}
	}

	await withRenewingReadCredential(
		{
			url: target.tenantUrl,
			...dependencies.renewal,
			...(configuredNetrc !== undefined && { existingNetrc: configuredNetrc }),
			issue: async (signal) => {
				const credential = await issue({
					tenantUrl: target.tenantUrl,
					...(cache !== undefined && { cache }),
					audience: options.audience ?? audienceSchema.parse(target.tenantUrl),
					resources,
					fetcher,
					environment: {
						requestUrl: environment.ACTIONS_ID_TOKEN_REQUEST_URL,
						requestToken: environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
					},
					signal,
					now: dependencies.renewal?.now ?? Date.now
				});

				if (
					cacheCredential !== undefined &&
					resources.every(
						(resource) =>
							resource.type === 'cupboard_cache' && resource.mode === 'metadata'
					)
				) {
					return {
						...credential,
						user: cacheCredential.user,
						password: cacheCredential.password
					};
				}

				return credential;
			},
			...(dependencies.signal !== undefined && { signal: dependencies.signal })
		},
		async ({ netrcFile, factsFile, signal }) => {
			const childEnvironment = environmentWithReadAccess(
				environment,
				netrcFile
			);

			if (factsFile !== undefined) {
				childEnvironment[readAccessFileEnvironment] = factsFile;
			}
			await runOwnedChild(command, childEnvironment, {
				...dependencies,
				signal
			});
		}
	);
}

async function runOwnedChild(
	command: ChildCommand,
	environment: NodeJS.ProcessEnv,
	dependencies: RunReadAccessDependencies
): Promise<void> {
	let exit: ChildExit;
	try {
		exit = await (dependencies.runChild ?? runChild)({
			command,
			environment,
			...(dependencies.signal !== undefined && { signal: dependencies.signal })
		});
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			throw new RunExecutableNotFoundError(command[0], { cause: error });
		}
		throw error;
	}

	throwIfAborted(dependencies.signal);
	if (childExitCode(exit) !== 0) {
		throw new RunCommandFailedError(exit.status, exit.signal);
	}
}

function environmentWithReadAccess(
	environment: NodeJS.ProcessEnv,
	netrcFile: string
): NodeJS.ProcessEnv {
	const setting = `netrc-file = ${netrcFile}`;
	const existing = environment.NIX_CONFIG;
	const separator =
		existing === undefined || existing === '' || existing.endsWith('\n')
			? ''
			: '\n';

	return {
		...environment,
		NIX_CONFIG: `${existing ?? ''}${separator}${setting}`
	};
}

async function readConfiguredNetrc(
	file: string,
	read: (file: string, encoding: 'utf8') => Promise<string>
): Promise<string | undefined> {
	try {
		return await read(file, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}

		throw error;
	}
}

function staticCredentialFor(
	url: URL,
	substituters: readonly string[],
	netrc: string | undefined
): BasicCredential | undefined {
	for (const uri of substituters) {
		let configured: URL;
		try {
			configured = new URL(uri);
		} catch {
			continue;
		}

		if (
			configured.origin === url.origin &&
			configured.pathname.replace(/\/+$/u, '') ===
				url.pathname.replace(/\/+$/u, '') &&
			configured.username !== ''
		) {
			return {
				user: readUserSchema.parse(decodeURIComponent(configured.username)),
				password: decodeURIComponent(configured.password)
			};
		}
	}

	const fromNetrc =
		netrc === undefined ? undefined : netrcCredentialFor(netrc, url.hostname);

	return fromNetrc === undefined
		? undefined
		: {
				user: readUserSchema.parse(fromNetrc.login),
				password: fromNetrc.password
			};
}

function parseReuseView(value: string): ReuseViewName {
	const parsed = reuseViewNameSchema.safeParse(value);
	if (!parsed.success) {
		throw new InvalidArgumentError(
			'A reuse view name must contain 1 to 63 lowercase letters, digits, dots, underscores or hyphens and start with a letter or digit.'
		);
	}

	return parsed.data;
}

function collectReadCache(
	value: string,
	previous: CacheTarget[]
): CacheTarget[] {
	return [...previous, cacheTargetFromUrl(parseWorkerUrl(value))];
}

function readTargetFromUrl(url: URL): ReadTarget {
	const segments = url.pathname.split('/');
	if (segments.at(-2) !== 'reuse') {
		return cacheTargetFromUrl(url);
	}

	const tenantUrl = new URL(url);
	tenantUrl.pathname = segments.slice(0, -2).join('/');
	const tenant = cacheTargetFromUrl(tenantUrl);
	const view = parseReuseView(decodeURIComponent(segments.at(-1) ?? ''));
	if (reuseViewUrl(tenant.tenantUrl, view).href !== url.href) {
		throw new InvalidArgumentError('Pass a canonical reuse view URL.');
	}

	return { tenantUrl: tenant.tenantUrl, view };
}

export function registerRunCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('run')
		.description('Run a command with renewable cache read access in CI.')
		.usage('<cache-or-view-url> [options] -- <command...>')
		.argument('<cache-or-view-url>', 'cache or reuse view URL', parseWorkerUrl)
		.argument('<command...>', 'command to run after --')
		.option(
			'--github-oidc',
			'use temporary GitHub Actions read access even if the cache is public or saved read credentials are present; requires id-token: write'
		)
		.option(
			'--audience <audience>',
			'OIDC audience (default: the tenant URL)',
			parseAudience
		)
		.option(
			'--cache-metadata',
			'request access to cache configuration while using an existing credential to download paths'
		)
		.option(
			'--read-cache <cache-url>',
			'additional cache in this tenant to include in the OIDC read session (repeatable)',
			collectReadCache,
			[]
		)
		.option(
			'--read-cache-metadata <cache-url>',
			'additional cache in this tenant whose configuration the command needs (repeatable)',
			collectReadCache,
			[]
		)
		.option(
			'--reuse-view <name>',
			'reuse view whose private cache content the command will read',
			parseReuseView
		)
		.addHelpText(
			'after',
			"\nThe child inherits stdin, stdout and stderr. The command returns the child's exit status, or 128 plus the signal number when a signal terminates the child. A missing executable exits 127. OIDC acquisition or renewal failures use Cupboard's own exit statuses, including 77 for refused authority and 75 for temporary failures."
		)
		.action(async (url: URL, commandParts: string[], options: RunOptions) => {
			const target = readTargetFromUrl(url);

			if (options.cacheMetadata === true && 'view' in target) {
				throw new InvalidArgumentError(
					'--cache-metadata requires a cache URL.'
				);
			}
			if ('view' in target && options.reuseView !== undefined) {
				throw new InvalidArgumentError(
					'A reuse view URL cannot be combined with --reuse-view.'
				);
			}

			const separator = program.rawArgs.indexOf('--');
			if (
				separator === -1 ||
				commandParts.length !== program.rawArgs.length - separator - 1
			) {
				throw new InvalidArgumentError('Pass the command after --.');
			}

			const [executable, ...arguments_] = commandParts;
			if (executable === undefined) {
				throw new InvalidArgumentError('Pass a command after --.');
			}

			await runWithReadAccess(target, [executable, ...arguments_], options, {
				signal: programOptions.signal
			});
		});
}
