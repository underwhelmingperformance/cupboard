import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix-store/scalars';
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
import { tenantRpc } from '../client/orpc.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface InspectOptions {
	readonly cache?: string;
}

/**
 * The slice of the derived client the inspect command consumes, in the
 * contract's input and output shapes; the real `tenantRpc(...).paths`
 * satisfies it by construction.
 */
export interface InspectClient {
	inspect(input: { cacheName: string; hash: string }): Promise<PathInspection>;
}

// Accept either a full store path or a bare store-path hash, so a path found by
// its narinfo name (as nixbuild and the S3 listing report it) inspects directly.
function storePathHashOf(reference: string): string {
	return reference.includes('/') ? StorePath.hash(reference) : reference;
}

export function registerInspectCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('inspect')
		.description('Show a store path: its narinfo summary and ingestion origin.')
		.argument('<url>', tenantUrlArgument)
		.argument('<store-path>', 'a store path or its store-path hash')
		.option('--cache <name>', 'inspect a named cache rather than the default')
		.action(async (url: string, reference: string, options: InspectOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runInspect(
				selectorForCache(options.cache ?? DEFAULT_CACHE),
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
	if (origin === undefined) {
		return 'native push';
	}

	return `${origin.label} (${origin.credentialId})`;
}
