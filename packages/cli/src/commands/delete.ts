import { type DeletePathResponse, StorePath } from '@cupboard/shared';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client.ts';
import { createReporter, type Reporter } from '../reporter.ts';

interface DeleteOptions {
	readonly token: string;
	readonly cache?: string;
}

export interface DeleteClient {
	deleteStorePath(
		token: AccessCredential,
		storePathHash: string
	): Promise<DeletePathResponse>;
}

export function registerDeleteCommand(program: Command): void {
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
			const client = CupboardClient.fromUrl(url, options.cache);
			const token = cachedOwnerProvider();

			await runDelete(storePath, token, reporter, client);
		});
}

export async function runDelete(
	storePath: string,
	token: AccessCredential,
	reporter: Reporter,
	client: DeleteClient
): Promise<void> {
	const storePathHash = StorePath.hash(storePath);

	const result = await reporter.phase('Deleting from cupboard', () =>
		client.deleteStorePath(token, storePathHash)
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
