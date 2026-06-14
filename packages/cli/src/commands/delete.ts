import type { CliUi } from '@cupboard/cli-ui';
import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix/scalars';
import { StorePath } from '@cupboard/nix/store-path';
import type { DeletePathResponse } from '@cupboard/protocol/upload';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface DeleteOptions {
	readonly cache?: string;
	readonly yes?: boolean;
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
		.argument('<url>', tenantUrlArgument)
		.argument(
			'<store-path>',
			'store path to delete (e.g. /nix/store/<hash>-<name>)'
		)
		.option(
			'--cache <name>',
			'delete from a named cache rather than the default'
		)
		.option('-y, --yes', 'delete without the confirmation prompt')
		.action(async (url: string, storePath: string, options: DeleteOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runDelete(
				selectorForCache(options.cache ?? DEFAULT_CACHE),
				storePath,
				ui,
				rpc.paths
			);
		});
}

export async function runDelete(
	cacheName: string,
	storePath: string,
	ui: CliUi,
	client: DeleteClient
): Promise<void> {
	const storePathHash = StorePath.hash(storePath);

	const outcome = await ui.confirm({
		message: `Permanently delete ${storePath} from the cache?`
	});

	if (outcome !== 'yes') {
		ui.cancelled('Nothing was deleted.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Deleting from cupboard', () =>
		client.remove({ cacheName, hash: storePathHash })
	);

	reporter.result({
		kind: 'deleted-path',
		data: result,
		rows: [
			{ label: 'Store path hash', value: result.storePathHash },
			{ label: 'Deleted', value: result.deleted ? 'yes' : 'not present' },
			{ label: 'NAR', value: describeNarOutcome(result) }
		]
	});
}

export function describeNarOutcome(result: DeletePathResponse): string {
	if (!result.deleted) {
		return 'n/a';
	}

	return result.narScheduledForDeletion
		? 'scheduled for deletion'
		: 'retained (still referenced)';
}
