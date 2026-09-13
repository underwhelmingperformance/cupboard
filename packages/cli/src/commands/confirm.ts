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
import { parseWorkerUrl } from '../client/transport.ts';
import { ConfirmIncompleteError, PathsNotConfirmedError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface ConfirmOptions {
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

export function registerConfirmCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('confirm')
		.description('Confirm published store paths without uploading their bytes.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<arguments...>',
			'optional cache name followed by store paths already published to the cache'
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
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # Confirm paths that a previous job already published',
				'  cupboard confirm --github-oidc https://cache.example.workers.dev/t/acme \\',
				'    /nix/store/<hash>-app /nix/store/<hash>-runtime'
			].join('\n')
		)
		.action(async (url: URL, storePaths: string[], options: ConfirmOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const resolved = await resolveAuthorisedCachePositionals(
				url,
				storePaths,
				{
					minimumPayload: 1,
					payloadDescription: 'a store path',
					authorise: (target) =>
						authenticateForPush(
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
				resolved.payload,
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

		throw new ConfirmIncompleteError(confirmedBatches, totalBatches, error);
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
		value: 'no retention grace policy matched'
	};
}
