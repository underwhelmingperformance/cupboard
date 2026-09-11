import type { CliUi } from '@cupboard/cli-ui';
import type { CacheScope } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type { DeletePathResponse } from '@cupboard/protocol/upload';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { resolveAuthorisedCachePositionals } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { CommandPayloadRequiredError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface DeleteOptions {
	readonly yes?: boolean;
}

export interface DeleteClient {
	remove: CacheScopedClient<
		{
			hash: string;
		},
		DeletePathResponse
	>;
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
			'<arguments...>',
			'optional cache name followed by the store path to delete'
		)
		.option('-y, --yes', 'delete without the confirmation prompt')
		.action(async (url: URL, positionals: string[], options: DeleteOptions) => {
			const resolved = await resolveAuthorisedCachePositionals(
				url,
				positionals,
				{
					minimumPayload: 1,
					maximumPayload: 1,
					payloadDescription: 'a store path',
					authorise: (target) =>
						cachedOwnerProvider(target.tenantUrl, {
							signal: programOptions.signal
						}),
					signal: programOptions.signal
				}
			);
			const [storePath] = resolved.payload;

			if (storePath === undefined) {
				throw new CommandPayloadRequiredError('a store path');
			}

			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(resolved.target.tenantUrl, {
				credential: resolved.credential,
				signal: programOptions.signal
			});

			await runDelete(resolved.target.cache, storePath, ui, rpc.paths);
		});
}

export async function runDelete(
	cache: CacheScope,
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
		callInCache(client.remove, cache, { hash: storePathHash })
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
