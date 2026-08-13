import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import type { StoreBackend } from '../../packages/nix/src/store-client.ts';
import {
	defaultStoreClientEnvironment,
	resolveStoreBackend
} from '../../packages/nix/src/store-client.ts';
import { discoverNixStoreConfig } from '../../packages/nix/src/store-config.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

import type { Oracle } from './oracle.ts';

/**
 * `nix store info` reports the store a configuration resolved to, where
 * `nix config show` reports the `store` setting as written. That resolution is
 * what `resolveStoreBackend` answers, so it is the oracle for it.
 *
 * Nix prints the resolved URL before it connects to the store, so a
 * configuration naming a daemon socket that is not there still says which
 * store was selected. The status is not read for that reason: selecting a
 * store and reaching it are separate questions, and only the first is asked
 * here.
 */
const storeInfoArguments = [
	'--extra-experimental-features',
	'nix-command',
	'store',
	'info',
	'--json'
];

const storeInfoSchema = z.object({ url: z.string() });

export class StoreNotResolvedError extends Error {
	constructor(
		public readonly stdout: string,
		public readonly stderr: string
	) {
		super('nix store info named no store');
		this.name = 'StoreNotResolvedError';
	}
}

/** The store a configuration selected, in the terms both sides can state. */
export interface ResolvedStore {
	readonly kind: 'daemon' | 'local' | 'ssh-ng' | 'other';
}

/**
 * The store a `nix store info` URL names.
 *
 * Nix states the store's directories in the URL only when they came from the
 * URI's own parameters; directories the environment names leave a plain
 * `local`. What both sides can always state is which backend was selected,
 * which is the whole of what `resolveStoreBackend` decides.
 */
function resolvedStoreOfUrl(url: string): ResolvedStore {
	// Nix writes the daemon at its usual socket as `daemon` and one at any
	// other socket as the `unix://` URL naming it. Both are the daemon store.
	if (url === 'daemon' || url.startsWith('unix://')) {
		return { kind: 'daemon' };
	}

	if (url === 'local' || url.startsWith('local://')) {
		return { kind: 'local' };
	}

	return { kind: url.startsWith('ssh-ng://') ? 'ssh-ng' : 'other' };
}

function resolvedStoreOfBackend(backend: StoreBackend): ResolvedStore {
	return { kind: backend.backend };
}

/** Where a fixture's own directories sit, for a case that names them. */
export interface FixtureDirectories {
	readonly home: string;
	readonly storeDirectory: string;
	readonly stateDirectory: string;
	/** A socket path for a `unix://` store, which nothing listens on. */
	readonly socketPath: string;
	/** A data home for the store Nix falls back to where one is called for. */
	readonly dataHome: string;
}

/** The environment variables a case adds over the isolated ones. */
export type StoreEnvironment = (
	directories: FixtureDirectories
) => Readonly<Record<string, string>>;

/** Puts one environment to both sides and reports the store each selected. */
export async function resolvedStores(
	oracle: Oracle,
	environmentFor: StoreEnvironment
): Promise<{ oracle: ResolvedStore; client: ResolvedStore; url: string }> {
	return withTemporaryDirectory('cupboard-conformance-store-', async (home) => {
		const directories: FixtureDirectories = {
			home,
			storeDirectory: path.join(home, 'store'),
			stateDirectory: path.join(home, 'state'),
			socketPath: path.join(home, 'socket'),
			dataHome: path.join(home, 'data')
		};

		await mkdir(directories.storeDirectory, { recursive: true });
		await mkdir(directories.stateDirectory, { recursive: true });

		const environment = {
			...(await isolatedEnvironment(home)),
			...environmentFor(directories)
		};
		const shown = await oracle.run(storeInfoArguments, { env: environment });
		const url = storeInfoUrl(shown.stdout);

		if (url === undefined) {
			throw new StoreNotResolvedError(shown.stdout, shown.stderr);
		}

		const clientEnvironment = {
			...defaultStoreClientEnvironment,
			env: environment,
			homeDirectory: () => home
		};
		const backend = resolveStoreBackend(
			discoverNixStoreConfig(clientEnvironment),
			clientEnvironment
		);

		return {
			oracle: resolvedStoreOfUrl(url),
			client: resolvedStoreOfBackend(backend),
			url
		};
	});
}

function storeInfoUrl(stdout: string): string | undefined {
	const trimmed = stdout.trim();

	if (trimmed === '') {
		return;
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return;
	}

	const result = storeInfoSchema.safeParse(parsed);

	return result.success ? result.data.url : undefined;
}

/**
 * Why the store Nix falls back to cannot be exercised here, or nothing when it
 * can.
 *
 * Nix compiles that fallback in for Linux alone, and offers it only when
 * nothing else could have been meant: a machine holding a Nix state directory
 * has an install that names its own directories, so the fallback is off. Every
 * machine with Nix installed holds one, which is every machine this suite runs
 * on, so the case reports itself as skipped rather than passing.
 */
export function chrootFallbackUnavailable(): string | undefined {
	if (process.platform !== 'linux') {
		return 'the store Nix falls back to is compiled in for Linux alone';
	}

	const stateDirectory = '/nix/var/nix';

	return existsSync(stateDirectory)
		? `${stateDirectory} exists, which is what turns the fallback off`
		: undefined;
}
