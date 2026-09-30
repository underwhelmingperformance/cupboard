import { readFile } from 'node:fs/promises';
import { constants as signalNumbers } from 'node:os';
import process from 'node:process';

import {
	discoverNixStoreConfig,
	netrcCredentialFor,
	type NixStoreConfig
} from '@cupboard/nix';
import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';
import {
	readAccessFileEnvironment,
	type ReadResource,
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import {
	type ReuseViewName,
	reuseViewNameSchema
} from '@cupboard/protocol/reuse-views';
import { type BasicCredential, readUserSchema } from '@cupboard/shared/http';
import { type Command, InvalidArgumentError } from 'commander';

import { throwIfAborted } from '../abort.ts';
import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { fetchGithubOidcToken } from '../auth/github-oidc.ts';
import {
	type ReadCredentialLease,
	type ReadCredentialSessionOptions,
	withRenewingReadCredential
} from '../auth/read-credential-session.ts';
import { childExitCode } from '../build-push/build-push.ts';
import {
	type ChildCommand,
	type RunChild,
	runChild
} from '../build-push/supervisor.ts';
import type { CacheTarget } from '../cache-target.ts';
import { cacheTargetFromUrl } from '../cache-target.ts';
import type { ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseWorkerUrl, resilientFetcher } from '../client/transport.ts';
import { CliError } from '../errors.ts';

interface RunOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly reuseView?: ReuseViewName;
	readonly cacheMetadata?: boolean;
}

interface ViewTarget {
	readonly tenantUrl: URL;
	readonly view: ReuseViewName;
}

type ReadTarget = CacheTarget | ViewTarget;

interface IssueReadCredentialInput {
	readonly target: ReadTarget;
	readonly audience: Audience;
	readonly resources: readonly ReadResource[];
	readonly signal: AbortSignal;
	readonly fetcher: typeof fetch;
	readonly environment: NodeJS.ProcessEnv;
}

export interface RunReadAccessDependencies {
	readonly environment?: NodeJS.ProcessEnv;
	readonly storeConfig?: NixStoreConfig;
	readonly readFile?: (file: string, encoding: 'utf8') => Promise<string>;
	readonly fetcher?: typeof fetch;
	readonly issue?: (
		input: IssueReadCredentialInput
	) => Promise<ReadCredentialLease>;
	readonly runChild?: RunChild;
	readonly signal?: AbortSignal;
	readonly renewal?: Pick<
		ReadCredentialSessionOptions,
		'renewalMarginMs' | 'safetyMarginMs' | 'retryDelayMs'
	>;
}

export class UnreadableReadCredentialFileError extends CliError {
	constructor(file: string) {
		super(
			`Cannot preserve credentials from the configured Nix netrc at ${file}. Make the file readable before requesting temporary read access.`
		);
		this.name = 'UnreadableReadCredentialFileError';
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
		await runOwnedChild(command, environment, dependencies);

		return;
	}

	const storeConfig = dependencies.storeConfig ?? discoverNixStoreConfig();
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

	const cacheCredential =
		targetUrl === undefined
			? undefined
			: staticCredentialFor(
					targetUrl,
					storeConfig.substitution.substituters,
					configuredNetrc
				);
	const requiresCacheOidc =
		targetUrl !== undefined &&
		(options.cacheMetadata === true || cacheCredential === undefined);
	const viewCredential =
		viewUrl === undefined
			? undefined
			: staticCredentialFor(
					viewUrl,
					storeConfig.substitution.substituters,
					configuredNetrc
				);
	const requiresViewOidc =
		viewUrl !== undefined && viewCredential === undefined;

	if (!requiresCacheOidc && !requiresViewOidc) {
		await runOwnedChild(command, environment, dependencies);
		return;
	}

	if (isNetrcUnreadable) {
		throw new UnreadableReadCredentialFileError(
			storeConfig.fileTransfer.netrcFile
		);
	}

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
		...(requiresViewOidc && viewName !== undefined
			? [{ type: 'cupboard_view' as const, view: viewName }]
			: [])
	];

	await withRenewingReadCredential(
		{
			url: target.tenantUrl,
			...dependencies.renewal,
			...(configuredNetrc !== undefined && { existingNetrc: configuredNetrc }),
			issue: async (signal) => {
				const credential = await issue({
					target,
					audience: options.audience ?? audienceSchema.parse(target.tenantUrl),
					resources,
					fetcher,
					environment,
					signal
				});

				if (
					!requiresViewOidc &&
					cacheCredential !== undefined &&
					options.cacheMetadata === true
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
	const exit = await (dependencies.runChild ?? runChild)({
		command,
		environment,
		...(dependencies.signal !== undefined && { signal: dependencies.signal })
	});
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

async function issueGithubReadCredential(
	input: IssueReadCredentialInput
): Promise<ReadCredentialLease> {
	const requestedAtMs = Date.now();
	const client = new CupboardClient(
		input.target.tenantUrl,
		input.fetcher,
		'cache' in input.target ? input.target.cache : { kind: 'default' },
		input.signal
	);
	const subject = await fetchGithubOidcToken({
		audience: input.audience,
		signal: input.signal,
		fetcher: client.fetcher,
		environment: {
			requestUrl: input.environment.ACTIONS_ID_TOKEN_REQUEST_URL,
			requestToken: input.environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
		}
	});
	const exchanged = await client.acquireReadAccess(subject, input.resources);

	return {
		user: readTokenBasicUser,
		password: `${readTokenPasswordPrefix}${exchanged.access_token}`,
		expiresAtMs: requestedAtMs + exchanged.expires_in * 1000,
		resources: exchanged.read_resources,
		authorizationDetails: exchanged.authorization_details
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
			'acquire server-resolved read access through GitHub Actions OIDC'
		)
		.option(
			'--audience <audience>',
			'OIDC audience (default: the tenant URL)',
			parseAudience
		)
		.option(
			'--cache-metadata',
			'acquire only cache metadata for setup when content uses a static credential'
		)
		.option(
			'--reuse-view <name>',
			'reuse view whose private cache content the command will read',
			parseReuseView
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
