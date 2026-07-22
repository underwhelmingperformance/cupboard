import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix-store/scalars';
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
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { ConfirmIncompleteError, PathsNotConfirmedError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface ConfirmOptions {
	readonly cache?: string;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

/**
 * The slice of the derived client the confirm command consumes, in the
 * contract's input and output shapes; the real `tenantRpc(...).uploads`
 * satisfies it by construction.
 */
export interface ConfirmClient {
	confirm(input: {
		cacheName: string;
		storePathHashes: string[];
	}): Promise<UploadConfirmResponse>;
}

export function registerConfirmCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('confirm')
		.description(
			'Confirm an unretained publication by store path, extending its ' +
				'retention grace without uploading any bytes.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<store-paths...>', 'store paths already published to the cache')
		.option(
			'--cache <name>',
			'confirm against a named cache rather than the default'
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
				'  # Refresh the grace deadline on paths a previous job already published',
				'  cupboard confirm --github-oidc https://cache.example.workers.dev/t/acme \\',
				'    /nix/store/<hash>-app /nix/store/<hash>-runtime'
			].join('\n')
		)
		.action(async (url: URL, storePaths: string[], options: ConfirmOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const cacheName = selectorForCache(options.cache ?? DEFAULT_CACHE);
			const credential = await authenticateForPush(
				CupboardClient.fromUrl(url, { signal: programOptions.signal }),
				{
					githubOidc: options.githubOidc,
					audience: options.audience ?? audienceSchema.parse(url),
					authorizationDetails: confirmAuthorizationDetails({
						cacheSelector: cacheName
					})
				}
			);
			const rpc = tenantRpc(url, {
				credential,
				signal: programOptions.signal
			});

			await runConfirm(cacheName, storePaths, reporter, rpc.uploads);
		});
}

export async function runConfirm(
	cacheName: string,
	storePaths: readonly string[],
	reporter: Reporter,
	client: ConfirmClient
): Promise<void> {
	const storePathHashes = storePaths.map((storePath) =>
		StorePath.hash(storePath)
	);
	const storePathsByHash = new Map<string, string>(
		storePaths.map((storePath) => [StorePath.hash(storePath), storePath])
	);
	// The server bounds one confirm request, so a closure larger than the
	// bound is split across sequential requests. The extensions a batch
	// applied are server-side facts whether or not a later batch's request
	// fails, so what confirmed is reported either way.
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
				const batch = await client.confirm({
					cacheName,
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
