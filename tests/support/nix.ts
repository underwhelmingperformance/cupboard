import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { z } from 'zod';

import {
	temporaryRoot,
	waitForFile,
	withTemporaryDirectory
} from './filesystem.ts';
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
	readonly netrcFile?: string;
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

	private constructor(
		private readonly fsRoot: string,
		private readonly storeArguments: readonly string[],
		private readonly environment: NodeJS.ProcessEnv
	) {}

	private run(
		command: string,
		arguments_: readonly string[]
	): ReturnType<typeof runCommand> {
		return runCommand(command, [...this.storeArguments, ...arguments_], {
			env: this.environment
		});
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
			'false',
			// Build locally; the test derivations have no store inputs, so inheriting
			// the host's substituters only risks a flake against an external cache.
			'--option',
			'substituters',
			''
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

	/**
	 * Collects everything no root protects. On the host store this would
	 * discard real data, so it is only meaningful for a chroot store the test
	 * owns.
	 */
	async collectGarbage(): Promise<void> {
		await this.run('nix-store', ['--gc']);
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
			options.requireSigs ? 'true' : 'false',
			...(options.netrcFile === undefined
				? []
				: ['--option', 'netrc-file', options.netrcFile])
		]);
	}
}

export interface DivertedNixDaemonOptions {
	readonly root: string;
	readonly home: string;
	/**
	Where the daemon listens; must be short enough for `sun_path`.
	*/
	readonly socketPath: string;
}

/**
 * A dedicated `nix-daemon` serving a diverted (`local?root=`) store over its
 * own socket. Temporary roots exist only behind a daemon connection, so a
 * test that exercises them against a store it owns starts one of these and
 * points a daemon client at {@link socketPath}. The daemon runs as the test
 * user with the same isolated configuration the stores use.
 */
export class DivertedNixDaemon {
	static async start(
		options: DivertedNixDaemonOptions
	): Promise<DivertedNixDaemon> {
		const environment = {
			...(await isolatedEnvironment(options.home)),
			NIX_DAEMON_SOCKET_PATH: options.socketPath
		};
		const child = spawn(
			'nix-daemon',
			['--store', `local?root=${options.root}`],
			{ env: environment, stdio: ['ignore', 'ignore', 'pipe'] }
		);
		const stderr: Buffer[] = [];
		child.stderr.on('data', (chunk: Buffer) => {
			stderr.push(chunk);
		});

		await waitForDaemonSocket(child, options.socketPath, () =>
			Buffer.concat(stderr).toString('utf8')
		);

		return new DivertedNixDaemon(child, options.socketPath);
	}

	private constructor(
		private readonly child: ChildProcess,
		public readonly socketPath: string
	) {}

	async stop(): Promise<void> {
		if (this.child.stderr?.closed === true) {
			return;
		}

		const closed = new Promise<void>((resolve) => {
			this.child.once('close', () => {
				resolve();
			});
		});

		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill();
		}

		await closed;
	}
}

export async function waitForDaemonSocket(
	child: ChildProcess,
	socketPath: string,
	stderr: () => string
): Promise<void> {
	const socketWait = new AbortController();
	const processClose = Promise.withResolvers<'closed'>();
	let processError: Error | undefined;
	const onError = (error: Error): void => {
		processError = error;
	};
	const onClose = (): void => {
		processClose.resolve('closed');
	};

	child.once('error', onError);
	child.once('close', onClose);

	if (
		child.stderr?.closed === true ||
		(child.stderr === null &&
			(child.exitCode !== null || child.signalCode !== null))
	) {
		onClose();
	}

	try {
		const outcome = await Promise.race([
			waitForFile(socketPath, socketWait.signal),
			processClose.promise
		]);

		if (outcome === 'closed') {
			const daemonStderr = stderr();

			throw new NixDaemonStartError(
				socketPath,
				daemonStderr === '' ? (processError?.message ?? '') : daemonStderr
			);
		}
	} finally {
		socketWait.abort();
		child.removeListener('error', onError);
		child.removeListener('close', onClose);
	}
}

export class NixDaemonStartError extends Error {
	constructor(
		public readonly socketPath: string,
		public readonly daemonStderr: string
	) {
		super(`nix-daemon did not open its socket at ${socketPath}`);
		this.name = 'NixDaemonStartError';
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

/**
 * An environment in which Nix reads no configuration but what the harness puts
 * under `home`: the command features its own invocations require, and no user
 * files at all. Every Nix invocation a test makes runs in one of these, so the
 * machine's own settings never decide what the test observes.
 */
export async function isolatedEnvironment(
	home: string
): Promise<NodeJS.ProcessEnv> {
	const configDirectory = path.join(home, 'nix-conf');
	await mkdir(configDirectory, { recursive: true });
	await writeFile(
		path.join(configDirectory, 'nix.conf'),
		'experimental-features = nix-command flakes\n'
	);

	return {
		HOME: home,
		NIX_CONF_DIR: configDirectory,
		NIX_USER_CONF_FILES: '/dev/null',
		PATH: process.env.PATH ?? '',
		TMPDIR: temporaryRoot
	};
}

const pathInfoJsonSchema = z.object({
	narHash: z.string(),
	narSize: z.number(),
	references: z.array(z.string()),
	ca: z.string().nullish(),
	deriver: z.string().nullish()
});

function parsePathInfo(source: string, storePath: string): NixPathInfo {
	const document = z
		.record(z.string(), z.unknown())
		.safeParse(JSON.parse(source));

	if (!document.success) {
		throw new InvalidNixPathInfoError(storePath, source);
	}

	const parsed = pathInfoJsonSchema.safeParse(document.data[storePath]);

	if (!parsed.success) {
		throw new InvalidNixPathInfoError(storePath, source);
	}

	const entry = parsed.data;

	return {
		storePath,
		narHash: sriToHash(entry.narHash),
		narSize: entry.narSize,
		references: entry.references,
		ca: entry.ca ?? undefined,
		deriver: entry.deriver ?? undefined
	};
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
