import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NixSha256Hash } from '../../packages/shared/src/protocol.ts';

import { temporaryRoot, withTemporaryDirectory } from './filesystem.ts';
import { runCommand } from './process.ts';

export interface NixPathInfo {
	readonly storePath: string;
	readonly narHash: NixSha256Hash;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly ca?: string;
	readonly deriver?: string;
}

export interface RealiseOptions {
	readonly substituter: string;
	readonly trustedPublicKeys: readonly string[];
	readonly requireSigs: boolean;
}

/**
 * A Nix store rooted at a known filesystem location, paired with an isolated
 * configuration so tests never touch the user's real Nix settings.
 *
 * The host store (`/nix/store`) is the only one that can build derivations on
 * every platform: macOS cannot build into a diverted (`local?root=`) store.
 * Diverted stores still support `add` and substitution, which is all a clean
 * target store needs.
 */
export class NixStore {
	private constructor(
		private readonly fsRoot: string,
		private readonly storeArguments: readonly string[],
		private readonly environment: NodeJS.ProcessEnv
	) {}

	static async host(home: string): Promise<NixStore> {
		return new NixStore('/', [], await isolatedEnvironment(home));
	}

	static async chroot(root: string, home: string): Promise<NixStore> {
		return new NixStore(
			root,
			['--store', `local?root=${root}`],
			await isolatedEnvironment(home)
		);
	}

	async add(source: string): Promise<string> {
		const { stdout } = await this.run('nix-store', ['--add', source]);

		return stdout.trim();
	}

	async build(expression: string): Promise<string> {
		const { stdout } = await this.run('nix-build', [
			'--expr',
			expression,
			'--no-out-link',
			'--option',
			'sandbox',
			'false'
		]);

		return stdout.trim();
	}

	async pathInfo(storePath: string): Promise<NixPathInfo> {
		const { stdout } = await this.run('nix', [
			'path-info',
			'--json',
			'--json-format',
			'1',
			storePath
		]);

		return parsePathInfo(stdout, storePath);
	}

	physicalPath(storePath: string): string {
		return path.join(this.fsRoot, storePath);
	}

	async realise(storePath: string, options: RealiseOptions): Promise<void> {
		await this.run('nix-store', [
			'--realise',
			storePath,
			'--option',
			'substituters',
			options.substituter,
			'--option',
			'trusted-public-keys',
			options.trustedPublicKeys.join(' '),
			'--option',
			'require-sigs',
			options.requireSigs ? 'true' : 'false'
		]);
	}

	private run(
		command: string,
		arguments_: readonly string[]
	): ReturnType<typeof runCommand> {
		return runCommand(command, [...this.storeArguments, ...arguments_], {
			env: this.environment
		});
	}
}

/**
 * Generates an Ed25519 binary cache key pair and returns the public key in
 * Nix's `name:base64` form. Useful for proving that an untrusted signer is
 * rejected.
 */
export async function generatePublicKey(name: string): Promise<string> {
	return withTemporaryDirectory('cupboard-nix-key-', async (directory) => {
		const publicKeyPath = path.join(directory, 'public.key');
		await runCommand('nix-store', [
			'--generate-binary-cache-key',
			name,
			path.join(directory, 'secret.key'),
			publicKeyPath
		]);

		const publicKey = await readFile(publicKeyPath, 'utf8');

		return publicKey.trim();
	});
}

async function isolatedEnvironment(home: string): Promise<NodeJS.ProcessEnv> {
	const configDirectory = path.join(home, 'nix-conf');
	await mkdir(configDirectory, { recursive: true });
	await writeFile(path.join(configDirectory, 'nix.conf'), '');

	return {
		HOME: home,
		NIX_CONF_DIR: configDirectory,
		NIX_USER_CONF_FILES: '/dev/null',
		PATH: process.env.PATH ?? '',
		TMPDIR: temporaryRoot
	};
}

interface PathInfoJson {
	readonly narHash: string;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly ca?: string | null;
	readonly deriver?: string | null;
}

function parsePathInfo(source: string, storePath: string): NixPathInfo {
	const parsed = JSON.parse(source) as Record<string, unknown>;
	const entry = parsed[storePath];

	if (!isPathInfoJson(entry)) {
		throw new InvalidNixPathInfoError(storePath, source);
	}

	return {
		storePath,
		narHash: sriToHash(entry.narHash),
		narSize: entry.narSize,
		references: entry.references,
		ca: entry.ca ?? undefined,
		deriver: entry.deriver ?? undefined
	};
}

function isPathInfoJson(value: unknown): value is PathInfoJson {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const record = value as Record<string, unknown>;

	return (
		typeof record.narHash === 'string' &&
		typeof record.narSize === 'number' &&
		Array.isArray(record.references) &&
		record.references.every((reference) => typeof reference === 'string')
	);
}

function sriToHash(value: string): NixSha256Hash {
	const prefix = 'sha256-';

	if (!value.startsWith(prefix)) {
		throw new InvalidNixSRIHashError(value);
	}

	return NixSha256Hash.fromDigest(
		Buffer.from(value.slice(prefix.length), 'base64')
	);
}

export class InvalidNixPathInfoError extends Error {
	constructor(
		public readonly storePath: string,
		public readonly source: string
	) {
		super(`Invalid nix path-info output for ${storePath}`);
		this.name = 'InvalidNixPathInfoError';
	}
}

export class InvalidNixSRIHashError extends Error {
	constructor(public readonly value: string) {
		super(`Invalid Nix SRI hash: ${value}`);
		this.name = 'InvalidNixSRIHashError';
	}
}
