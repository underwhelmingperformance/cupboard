import {
	DeletePathRequest,
	type DeletePathResponse,
	StorePath
} from '@cupboard/shared';
import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { createReporter, type Reporter } from '../reporter.ts';

interface DeleteOptions {
	readonly token: string;
}

export interface DeleteClient {
	deleteStorePath(
		token: string,
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
		.requiredOption('--token <token>', 'admin token')
		.action(async (url: string, storePath: string, options: DeleteOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});

			await runDelete(
				storePath,
				options.token,
				reporter,
				CupboardClient.fromUrl(url)
			);
		});
}

export async function runDelete(
	storePath: string,
	token: string,
	reporter: Reporter,
	client: DeleteClient
): Promise<void> {
	// fromFields validates the hash alphabet and length; StorePath.hash only
	// splits the basename on the first dash.
	const request = DeletePathRequest.fromFields({
		storePathHash: StorePath.hash(storePath)
	});

	const result = await reporter.phase('Deleting from cupboard', () =>
		client.deleteStorePath(token, request.storePathHash)
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
