import { readFile } from 'node:fs/promises';

import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import {
	type CacheScope,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type UploadConfirmedPath,
	uploadConfirmMaxPaths,
	type UploadConfirmResponse
} from '@cupboard/protocol/upload';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { isAbortError } from '../abort.ts';
import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { confirmAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import { resolveAuthorisedCachePositionals } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { CupboardClient } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { translateRpcError } from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	CliUsageError,
	ConfirmIncompleteError,
	PathsNotConfirmedError
} from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

class ConfirmPathInputError extends CliUsageError {
	constructor(value: string, source: string, cause: InvalidStorePathError) {
		super(
			`Invalid store path '${value}' in ${source}. Pass an absolute store path with a 32-character Nix hash and a name.`,
			{ cause }
		);
		this.name = 'ConfirmPathInputError';
	}
}

function parseConfirmPath(
	value: string,
	source = 'the command arguments'
): StorePath {
	try {
		return new StorePath(value);
	} catch (error) {
		if (!(error instanceof InvalidStorePathError)) {
			throw error;
		}

		throw new ConfirmPathInputError(value, source, error);
	}
}

async function confirmFilePaths(
	file: string | undefined
): Promise<readonly StorePath[]> {
	if (file === undefined) {
		return [];
	}

	const contents = await readFile(file, 'utf8');

	return contents.split(/\r?\n/u).flatMap((line, index) => {
		const entry = line.trim();

		if (entry === '') {
			return [];
		}

		return [
			parseConfirmPath(entry, `--paths-file ${file}, line ${String(index + 1)}`)
		];
	});
}

interface ConfirmOptions {
	readonly pathsFile?: string;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

export interface ConfirmClient {
	confirm: CacheScopedClient<
		{
			storePathHashes: StorePathHash[];
		},
		UploadConfirmResponse
	>;
}

interface ConfirmCommandDependencies {
	/**
	 * Returns the token provider for the confirmation. Defaults to
	 * `authenticateForPush`, which uses GitHub Actions OIDC with `--github-oidc`
	 * and otherwise the owner session cached by `cupboard login`.
	 */
	readonly authenticate?: typeof authenticateForPush;
}

export function registerConfirmCommand(
	program: Command,
	programOptions: ProgramOptions = {},
	dependencies: ConfirmCommandDependencies = {}
): void {
	const authenticate = dependencies.authenticate ?? authenticateForPush;

	program
		.command('confirm')
		.description(
			'Check that store paths are already in a cache and refresh their grace ' +
				'period, without uploading anything.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'[arguments...]',
			'an optional cache name, then the store paths to check'
		)
		.option(
			'--paths-file <path>',
			'read additional store paths from this file, one per line'
		)
		.option(
			'--github-oidc',
			"sign in with the job's GitHub Actions OIDC token instead of your saved `cupboard login` session"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # Check paths that a previous job published',
				'  cupboard confirm --github-oidc https://cupboard.example.workers.dev/t/acme \\',
				'    /nix/store/<hash>-app /nix/store/<hash>-runtime'
			].join('\n')
		)
		.action(async (url: URL, storePaths: string[], options: ConfirmOptions) => {
			const filePaths = await confirmFilePaths(options.pathsFile);
			const reporter = commandUi(program, programOptions).reporter();
			const resolved = await resolveAuthorisedCachePositionals(
				url,
				storePaths,
				{
					minimumPayload: filePaths.length === 0 ? 1 : 0,
					payloadDescription: 'a store path',
					parsePayloadEntry: (entry) => parseConfirmPath(entry),
					authorise: (target) =>
						authenticate(
							CupboardClient.fromUrl(target.tenantUrl, {
								cache: target.cache,
								signal: programOptions.signal
							}),
							{
								githubOidc: options.githubOidc,
								audience:
									options.audience ?? audienceSchema.parse(target.tenantUrl),
								authorizationDetails: confirmAuthorizationDetails({
									cache: target.cache
								})
							}
						),
					signal: programOptions.signal
				}
			);
			const rpc = tenantRpc(resolved.target.tenantUrl, {
				credential: resolved.credential,
				signal: programOptions.signal
			});

			await runConfirm(
				resolved.target.cache,
				[...resolved.payload, ...filePaths].map((storePath) => storePath.value),
				reporter,
				rpc.uploads
			);
		});
}

export async function runConfirm(
	cache: CacheScope,
	storePaths: readonly string[],
	reporter: Reporter,
	client: ConfirmClient
): Promise<void> {
	const storePathHashes = storePaths.map((storePath) =>
		StorePath.hash(storePath)
	);
	const storePathsByHash = new Map<StorePathHash, string>(
		storePaths.map((storePath) => [StorePath.hash(storePath), storePath])
	);
	// The server caps each request, so submit larger sets in order. Report the
	// completed batches even if a later request fails because their confirmation
	// results are already durable.
	const paths: UploadConfirmResponse['paths'] = [];
	const totalBatches = Math.ceil(
		storePathHashes.length / uploadConfirmMaxPaths
	);
	let confirmedBatches = 0;

	try {
		await reporter.phase('Confirming published paths', async () => {
			for (
				let index = 0;
				index < storePathHashes.length;
				index += uploadConfirmMaxPaths
			) {
				const batch = await callInCache(client.confirm, cache, {
					storePathHashes: storePathHashes.slice(
						index,
						index + uploadConfirmMaxPaths
					)
				});

				paths.push(...batch.paths);
				confirmedBatches += 1;
			}
		});
	} catch (error) {
		if (paths.length === 0) {
			throw error;
		}

		reportConfirmedPaths(reporter, paths);

		if (isAbortError(error)) {
			throw error;
		}

		throw new ConfirmIncompleteError(
			confirmedBatches,
			totalBatches,
			translateRpcError(error, { keepAuthCause: true })
		);
	}

	reportConfirmedPaths(reporter, paths);

	const unconfirmed = paths.filter((path) => !path.confirmed);

	if (unconfirmed.length > 0) {
		throw new PathsNotConfirmedError(
			unconfirmed.map(
				(path) => storePathsByHash.get(path.storePathHash) ?? path.storePathHash
			)
		);
	}
}

function reportConfirmedPaths(
	reporter: Reporter,
	paths: UploadConfirmResponse['paths']
): void {
	reporter.result({
		kind: 'confirm-paths',
		data: { paths },
		rows: paths.map((path) => confirmRow(path))
	});
}

function confirmRow(path: UploadConfirmedPath): ResultRow {
	if (!path.confirmed) {
		return { label: path.storePathHash, value: 'not present' };
	}

	if (path.grace?.retainUntil !== undefined) {
		return {
			label: path.storePathHash,
			value: `kept until ${formatTimestamp(path.grace.retainUntil)}`
		};
	}

	return {
		label: path.storePathHash,
		value: 'no cache retention grace configured'
	};
}
