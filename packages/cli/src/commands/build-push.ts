import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import {
	createNixDaemonStoreClient,
	discoverNixStoreConfig,
	Nix
} from '@cupboard/nix';
import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import {
	type RootName,
	selectorForCache,
	storePathSchema,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { invocationIdSchema } from '@cupboard/protocol/build';
import type { Command } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { pushAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import { runBuildPush } from '../build-push/build-push.ts';
import { preflightBuildPush } from '../build-push/preflight.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient, storedCacheFor } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	parseTtl,
	parseWaitTimeout,
	type WaitTimeoutSeconds
} from '../duration.ts';
import { InvalidUploadConcurrencyError } from '../errors.ts';
import { pushClientFor } from '../push/push-client.ts';
import { parseRootName } from '../root-name.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { parsePathFile, validateRetentionChoice } from './push.ts';

interface BuildPushOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly root?: RootName;
	readonly ttl?: TtlSeconds;
	readonly retain?: boolean;
	readonly closure?: boolean;
	readonly intermediatePathsFile?: string;
	readonly runRoot?: RootName;
	readonly runRootTtl?: TtlSeconds;
	readonly cache?: string;
	readonly wait?: boolean;
	readonly waitTimeout?: WaitTimeoutSeconds;
	readonly uploadConcurrency?: number;
	readonly receiptFile?: string;
}

function parseUploadConcurrency(value: string): number {
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new InvalidUploadConcurrencyError(value);
	}

	return Number(value);
}

// The path file is transport only; every line must name a store path before
// any token is requested.
function parseStorePathFile(contents: string): readonly StorePathString[] {
	return parsePathFile(contents).map((line) => {
		const parsed = storePathSchema.safeParse(line);

		if (!parsed.success) {
			throw new InvalidStorePathError(line);
		}

		return parsed.data;
	});
}

export function registerBuildPushCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('build-push')
		.description(
			'Run a build command under streaming publication: completed outputs ' +
				'upload while the build continues, and a final reconciliation ' +
				'settles roots and writes the build receipt.'
		)
		.usage('<url> [options] -- <build command...>')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<command...>',
			'the build command to run, after a -- separator (e.g. nix build --no-link .#target)'
		)
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.option(
			'--root <name>',
			'replace this named root with the built targets once every one is confirmed servable',
			parseRootName
		)
		.option(
			'--ttl <duration>',
			'expire the retained targets after this duration (e.g. 7d, 12h); default permanent',
			parseTtl
		)
		.option(
			'--no-retain',
			"publish without any target root; kept only by the cache's retention grace policy, if one matches"
		)
		.option(
			'--closure',
			'publish the complete realised closure of the built targets (default: exactly the built outputs)'
		)
		.option(
			'--intermediate-paths-file <path>',
			'newline-delimited store paths to publish alongside the targets without retaining them as targets'
		)
		.option(
			'--run-root <name>',
			'bind a run root: every path joins this root as it commits, whether streamed or reconciled',
			parseRootName
		)
		.option(
			'--run-root-ttl <duration>',
			'expire the run root after this duration (e.g. 7d, 12h); default per the tenant retention policy, else permanent',
			parseTtl
		)
		.option('--cache <name>', 'push to a named cache rather than the default')
		.option(
			'--no-wait',
			'reconcile without waiting for deferred blobs to become servable; an unconfirmed root is left untouched'
		)
		.option(
			'--wait-timeout <duration>',
			'how long to wait for deferred blobs to become servable (e.g. 10m, 1h); default 10m',
			parseWaitTimeout
		)
		.option(
			'--upload-concurrency <n>',
			'how many blob uploads to run at once (default 6)',
			parseUploadConcurrency
		)
		.option(
			'--receipt-file <path>',
			'write the build receipt (JSON) to this file'
		)
		.addHelpText(
			'after',
			[
				'',
				'The build command runs with its output and exit status untouched: a',
				'failed build exits with the build command status. A successful',
				'build with failed publication or retention exits with the sysexits',
				'vocabulary: 77 authentication, 75 transient, 69 unavailable, and 74',
				'for a publication failure not otherwise classified.',
				'',
				'Examples:',
				'  # Build and stream the outputs to a tenant, replacing a named root',
				'  cupboard build-push https://cache.example.workers.dev/t/acme \\',
				'    --root github:acme/infra/main -- nix build --no-link .#app',
				'',
				'  # Build from CI with a GitHub Actions OIDC token and a run root',
				'  cupboard build-push --github-oidc --root github:acme/infra/main \\',
				'    --run-root github:acme/infra/run-123 --run-root-ttl 2d \\',
				'    https://cache.example.workers.dev/t/acme -- nix build --no-link .#app'
			].join('\n')
		)
		.action(
			async (url: URL, commandParts: string[], options: BuildPushOptions) => {
				validateRetentionChoice(options);

				const [executable, ...childArguments] = commandParts;

				if (executable === undefined) {
					return;
				}

				const intermediatePaths =
					options.intermediatePathsFile === undefined
						? undefined
						: parseStorePathFile(
								await readFile(options.intermediatePathsFile, 'utf8')
							);
				const reporter = commandUi(program, programOptions).reporter();
				const raw = CupboardClient.fromUrl(url, {
					cache: options.cache,
					signal: programOptions.signal
				});
				const cacheSelector = selectorForCache(storedCacheFor(options.cache));
				const targetRoot = options.retain === false ? undefined : options.root;
				const authorizationDetails = pushAuthorizationDetails({
					cacheSelector,
					attest: false,
					...(targetRoot !== undefined && { root: targetRoot }),
					...(options.runRoot !== undefined && { runRoot: options.runRoot })
				});
				const token = await authenticateForPush(raw, {
					githubOidc: options.githubOidc,
					audience: options.audience ?? audienceSchema.parse(url),
					authorizationDetails
				});

				const invocationId = invocationIdSchema.parse(randomUUID());
				const config = discoverNixStoreConfig();
				const daemon = createNixDaemonStoreClient(undefined, config);
				const nix = Nix.forStore(daemon, {
					storeDirectory: config.storeDirectory
				});

				await runBuildPush(
					{
						invocation: {
							kind: 'command',
							command: [executable, ...childArguments]
						},
						...(targetRoot !== undefined && { root: targetRoot }),
						...(options.ttl !== undefined && { ttlSeconds: options.ttl }),
						...(options.runRoot !== undefined && {
							runRoot: {
								name: options.runRoot,
								...(options.runRootTtl !== undefined && {
									ttlSeconds: options.runRootTtl
								})
							}
						}),
						...(options.closure !== undefined && {
							closure: options.closure
						}),
						...(intermediatePaths !== undefined && { intermediatePaths }),
						...(options.receiptFile !== undefined && {
							receiptFile: options.receiptFile
						}),
						...(options.wait !== undefined && { wait: options.wait }),
						...(options.waitTimeout !== undefined && {
							waitTimeoutSeconds: options.waitTimeout
						}),
						...(options.uploadConcurrency !== undefined && {
							uploadConcurrency: options.uploadConcurrency
						})
					},
					reporter,
					{
						client: pushClientFor(url, token, {
							cache: options.cache,
							signal: programOptions.signal
						}),
						store: nix,
						batchStore: {
							withConnection: (use) => daemon.withConnection(use)
						},
						storeDirectory: config.storeDirectory,
						invocationId,
						preflight: () =>
							preflightBuildPush({
								config,
								socketExists: (socketPath) => existsSync(socketPath),
								daemonTrust: () => daemon.daemonTrust(),
								invocationId,
								grants: authorizationDetails,
								cache: cacheSelector,
								...(options.runRoot !== undefined && {
									runRoot: options.runRoot
								}),
								...(targetRoot !== undefined && {
									targetRoots: [targetRoot]
								})
							}),
						resolveClosure: (paths) => nix.resolveClosure(paths)
					}
				);
			}
		);
}
