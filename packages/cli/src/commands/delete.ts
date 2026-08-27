import type { CliUi } from '@cupboard/cli-ui';
import { selectorForCache } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type {
	DeletePathResponse,
	ParsedDeletePathResponse
} from '@cupboard/protocol/upload';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { privateCacheOption } from '../cache-option.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import {
	type CacheSelectionOptions,
	resolveCacheSelection
} from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface DeleteOptions extends CacheSelectionOptions {
	readonly yes?: boolean;
}

export interface DeleteClient {
	remove(input: {
		cacheName: string;
		hash: string;
	}): Promise<ParsedDeletePathResponse>;
}

export function registerDeleteCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('delete')
		.description('Delete a single store path from the cache.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<store-path>',
			'store path to delete (e.g. /nix/store/<hash>-<name>)'
		)
		.option(
			'--cache <name>',
			'delete from a named cache rather than the default'
		)
		.addOption(privateCacheOption('delete from'))
		.option('-y, --yes', 'delete without the confirmation prompt')
		.action(async (url: URL, storePath: string, options: DeleteOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runDelete(
				selectorForCache(resolveCacheSelection(options)),
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
