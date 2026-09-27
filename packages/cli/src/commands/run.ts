import { readFile } from 'node:fs/promises';
import { constants as signalNumbers } from 'node:os';
import process from 'node:process';

import {
	discoverNixStoreConfig,
	netrcCredentialFor,
	type NixStoreConfig
} from '@cupboard/nix';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';
import type { AuthorizationDetails } from '@cupboard/protocol/grants';
import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import {
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import {
	type ReuseViewName,
	reuseViewNameSchema
} from '@cupboard/protocol/reuse-views';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import {
	basicAuthHeader,
	type BasicCredential,
	readUserSchema
} from '@cupboard/shared/http';
import { readResponseText } from '@cupboard/shared/response-body';
import { type Command, InvalidArgumentError } from 'commander';

import { abortReason, throwIfAborted } from '../abort.ts';
import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { contentReadAuthorizationDetails } from '../auth/attenuate.ts';
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
import { CacheInfoTimeoutError, CliError } from '../errors.ts';

const cacheInfoTimeoutMs = 30_000;

interface RunOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly reuseView?: ReuseViewName;
}

interface ViewTarget {
	readonly tenantUrl: URL;
	readonly view: ReuseViewName;
}

type ReadTarget = CacheTarget | ViewTarget;

interface IssueReadCredentialInput {
	readonly target: ReadTarget;
	readonly audience: Audience;
	readonly authorizationDetails: AuthorizationDetails;
	readonly signal: AbortSignal;
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
	readonly probeTimeoutMs?: number;
	readonly renewal?: Pick<
		ReadCredentialSessionOptions,
		'renewalMarginMs' | 'safetyMarginMs' | 'retryDelayMs'
	>;
}

export class ReadAccessProbeError extends CliError {
	constructor(url: URL, status: number) {
		super(
			`Could not check cache read access at ${url.href}: HTTP ${String(status)}`
		);
		this.name = 'ReadAccessProbeError';
	}
}

export class ReadAccessProbeDocumentError extends CliError {
	constructor(url: URL, options: ErrorOptions) {
		super(`Could not read valid cache information at ${url.href}`, options);
		this.name = 'ReadAccessProbeDocumentError';
	}
}

export class StaticReadCredentialRejectedError extends CliError {
	constructor(url: URL) {
		super(`The configured read credential was rejected by ${url.href}`);
		this.name = 'StaticReadCredentialRejectedError';
	}
}

export class ReadOidcRequiredError extends CliError {
	constructor() {
		super(
			'A private cache or reuse view needs read access. Pass --github-oidc in CI or configure a static read credential.'
		);
		this.name = 'ReadOidcRequiredError';
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
	const isCachePrivate =
		targetUrl !== undefined &&
		(await requiresOidc(
			targetUrl,
			undefined,
			fetcher,
			dependencies.signal,
			dependencies.probeTimeoutMs
		));
	const isViewPrivate =
		viewUrl !== undefined &&
		(await requiresOidc(
			viewUrl,
			undefined,
			fetcher,
			dependencies.signal,
			dependencies.probeTimeoutMs
		));

	if (!isCachePrivate && !isViewPrivate) {
		await runOwnedChild(command, environment, dependencies);
		return;
	}

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
		isCachePrivate &&
		(cacheCredential === undefined ||
			(await requiresOidc(
				targetUrl,
				cacheCredential,
				fetcher,
				dependencies.signal,
				dependencies.probeTimeoutMs
			)));
	const viewCredential =
		viewUrl === undefined
			? undefined
			: staticCredentialFor(
					viewUrl,
					storeConfig.substitution.substituters,
					configuredNetrc
				);
	const requiresViewOidc =
		isViewPrivate &&
		(viewCredential === undefined ||
			(await requiresOidc(
				viewUrl,
				viewCredential,
				fetcher,
				dependencies.signal,
				dependencies.probeTimeoutMs
			)));

	if (!requiresCacheOidc && !requiresViewOidc) {
		await runOwnedChild(command, environment, dependencies);
		return;
	}

	if (options.githubOidc !== true) {
		throw new ReadOidcRequiredError();
	}
	if (isNetrcUnreadable) {
		throw new UnreadableReadCredentialFileError(
			storeConfig.fileTransfer.netrcFile
		);
	}

	const authorizationDetails = contentReadAuthorizationDetails({
		...(requiresCacheOidc && cache !== undefined && { cache }),
		...(requiresViewOidc && { view: viewName })
	});
	const issue = dependencies.issue ?? issueGithubReadCredential;

	await withRenewingReadCredential(
		{
			url: target.tenantUrl,
			...dependencies.renewal,
			...(configuredNetrc !== undefined && { existingNetrc: configuredNetrc }),
			issue: (signal) =>
				issue({
					target,
					audience: options.audience ?? audienceSchema.parse(target.tenantUrl),
					authorizationDetails,
					signal
				}),
			...(dependencies.signal !== undefined && { signal: dependencies.signal })
		},
		async ({ netrcFile, signal }) => {
			const childEnvironment = environmentWithReadAccess(
				environment,
				netrcFile
			);
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

async function requiresOidc(
	resource: URL,
	staticCredential: BasicCredential | undefined,
	fetcher: typeof fetch,
	signal: AbortSignal | undefined,
	timeoutMs = cacheInfoTimeoutMs
): Promise<boolean> {
	const info = new URL(resource);
	info.pathname = `${resource.pathname.replace(/\/$/u, '')}/nix-cache-info`;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal =
		signal === undefined
			? timeoutSignal
			: AbortSignal.any([signal, timeoutSignal]);
	let response: Response | undefined;

	try {
		response = await fetcher(info, {
			signal: requestSignal,
			...(staticCredential !== undefined && {
				headers: basicAuthHeader(staticCredential)
			})
		});

		if (response.ok) {
			try {
				CacheInfo.parse(
					await readResponseText(response, {
						description: `cache information from ${info.href}`,
						maximumBytes: 1024 * 1024,
						signal: requestSignal
					})
				);
			} catch (error) {
				throw new ReadAccessProbeDocumentError(info, { cause: error });
			}

			return false;
		}

		if (response.status === 401) {
			if (staticCredential !== undefined) {
				throw new StaticReadCredentialRejectedError(resource);
			}

			return true;
		}

		throw new ReadAccessProbeError(resource, response.status);
	} catch (error) {
		if (signal?.aborted === true) {
			throw abortReason(signal);
		}

		if (timeoutSignal.aborted) {
			throw new CacheInfoTimeoutError(info, timeoutMs, { cause: error });
		}

		throw error;
	} finally {
		if (response !== undefined) {
			await discardResponseBody(response);
		}
	}
}

async function issueGithubReadCredential(
	input: IssueReadCredentialInput
): Promise<ReadCredentialLease> {
	const requestedAtMs = Date.now();
	const client = CupboardClient.fromUrl(input.target.tenantUrl, {
		cache: 'cache' in input.target ? input.target.cache : { kind: 'default' },
		signal: input.signal
	});
	const subject = await fetchGithubOidcToken({
		audience: input.audience,
		signal: input.signal,
		fetcher: client.fetcher
	});
	const exchanged = await client.tokenExchange(
		subject,
		subjectTokenTypeIdToken,
		input.authorizationDetails
	);

	return {
		user: readTokenBasicUser,
		password: `${readTokenPasswordPrefix}${exchanged.access_token}`,
		expiresAtMs: requestedAtMs + exchanged.expires_in * 1000
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
		.description(
			'Run a command with renewable private-cache read access in CI.'
		)
		.usage('<cache-or-view-url> [options] -- <command...>')
		.argument('<cache-or-view-url>', 'cache or reuse view URL', parseWorkerUrl)
		.argument('<command...>', 'command to run after --')
		.option(
			'--github-oidc',
			'request private-cache read access through GitHub Actions OIDC when needed'
		)
		.option(
			'--audience <audience>',
			'OIDC audience (default: the tenant URL)',
			parseAudience
		)
		.option(
			'--reuse-view <name>',
			'reuse view whose private cache content the command will read',
			parseReuseView
		)
		.action(async (url: URL, commandParts: string[], options: RunOptions) => {
			const target = readTargetFromUrl(url);
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
