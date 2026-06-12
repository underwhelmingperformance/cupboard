import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix/scalars';
import { StorePath } from '@cupboard/nix/store-path';
import type { DeletePathResponse } from '@cupboard/protocol/upload';
import { createReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';

interface DeleteOptions {
	readonly token: string;
	readonly cache?: string;
}

/**
 * The slice of the derived client the delete command consumes, in the
 * contract's input and output shapes; the real `tenantRpc(...).paths`
 * satisfies it by construction.
 */
export interface DeleteClient {
	remove(input: {
		cacheName: string;
		hash: string;
	}): Promise<DeletePathResponse>;
}

export function registerDeleteCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('delete')
		.description('Delete a single store path from the cache.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument(
			'<store-path>',
			'store path to delete (e.g. /nix/store/<hash>-<name>)'
		)
		.option(
			'--cache <name>',
			'delete from a named cache rather than the default'
		)
		.action(async (url: string, storePath: string, options: DeleteOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url),
				signal: programOptions.signal
			});

			await runDelete(
				selectorForCache(options.cache ?? DEFAULT_CACHE),
				storePath,
				reporter,
				rpc.paths
			);
		});
}

export async function runDelete(
	cacheName: string,
	storePath: string,
	reporter: Reporter,
	client: DeleteClient
): Promise<void> {
	const storePathHash = StorePath.hash(storePath);

	const result = await reporter.phase('Deleting from cupboard', () =>
		client.remove({ cacheName, hash: storePathHash })
	);

	reporter.result([
		{ label: 'Store path hash', value: result.storePathHash },
		{ label: 'Deleted', value: result.deleted ? 'yes' : 'not present' },
		{ label: 'NAR', value: describeNarOutcome(result) }
	]);
}

export function describeNarOutcome(result: DeletePathResponse): string {
	if (!result.deleted) {
		return 'n/a';
	}

	return result.narScheduledForDeletion
		? 'scheduled for deletion'
		: 'retained (still referenced)';
}
