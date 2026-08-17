import { selectorForCache } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type { PathInspection } from '@cupboard/protocol/paths';
import {
	formatBytes,
	formatCount,
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { storedCacheFor } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface InspectOptions {
	readonly cache?: string;
}

/**
The client operation used by the inspect command.
*/
export interface InspectClient {
	inspect(input: { cacheName: string; hash: string }): Promise<PathInspection>;
}

function storePathHashOf(reference: string): string {
	return reference.includes('/') ? StorePath.hash(reference) : reference;
}

export function registerInspectCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('inspect')
		.description('Show stored metadata and how a store path was committed.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<store-path>', 'a store path or its store-path hash')
		.option('--cache <name>', 'inspect a named cache rather than the default')
		.action(async (url: URL, reference: string, options: InspectOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runInspect(
				selectorForCache(storedCacheFor(options.cache)),
				storePathHashOf(reference),
				reporter,
				rpc.paths
			);
		});
}

export async function runInspect(
	cacheName: string,
	hash: string,
	reporter: Reporter,
	client: InspectClient
): Promise<void> {
	const path = await reporter.phase('Inspecting store path', () =>
		client.inspect({ cacheName, hash })
	);

	reporter.result({ kind: 'path', data: path, rows: inspectionRows(path) });
}

function inspectionRows(path: PathInspection): ResultRow[] {
	return [
		{ label: 'Store path', value: path.storePath },
		{ label: 'NAR hash', value: path.narHash },
		{ label: 'NAR size', value: formatBytes(path.narSize) },
		{ label: 'References', value: formatCount(path.references.length) },
		...(path.deriver === undefined
			? []
			: [{ label: 'Deriver', value: path.deriver }]),
		{ label: 'Generation', value: String(path.generation) },
		{ label: 'Created', value: formatTimestamp(path.createdAt) },
		{ label: 'Origin', value: describeOrigin(path.origin) }
	];
}

function describeOrigin(origin: PathInspection['origin']): string {
	switch (origin.kind) {
		case 'native': {
			return 'native push';
		}
		case 'redacted': {
			return 'S3 commit (credential hidden)';
		}
		case 's3': {
			return `S3 commit with ${origin.label} (${origin.credentialId})`;
		}
	}
}
