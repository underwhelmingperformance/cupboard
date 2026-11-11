import { spawn } from 'node:child_process';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type NixFingerprint,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type AbortableChildProcessLifecycle,
	observeChildProcess
} from '@cupboard/shared/child-process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	derivationArchiveName,
	exportDerivationClosure,
	importDerivationClosure,
	type TarStarter
} from './derivation-closure.ts';
import {
	CommandFailedError,
	DerivationClosureImportError,
	DerivationClosureUntrustedError
} from './errors.ts';
import type { NixCopyDependencies, NixCopyProcess } from './nix-copy.ts';

// A source from nixpkgs whose content address produces its store path.
const source = {
	storePath: storePathSchema.parse(
		'/nix/store/01gahr13mk3p411jhgxk7ab3pnl0c9yv-0001-No-impure-bin-sh.patch'
	),
	ca: 'fixed:r:sha256:0phr7gbi15dqnnnmq2jhs7y02ckskhnzdwj19p7bdwvayrp3in01',
	references: []
};
// A file added with `nix store add --mode flat`.
const flatFile = {
	storePath: storePathSchema.parse(
		'/nix/store/gy454w1cxaq731grqwylhzf4pp9r5izh-hello.txt'
	),
	ca: 'fixed:sha256:00xyyr3fi8l6hb839bv3f7yb86yjv7xi1cgh1xnhipym4asvb4aq',
	references: []
};
// Paths built locally, for example by import from derivation.
const builtOutput = {
	storePath: storePathSchema.parse(
		'/nix/store/6123456789abcdfghijklmnpqrsvwxyz-generated'
	),
	references: []
};
const builtDependent = {
	storePath: storePathSchema.parse(
		'/nix/store/7123456789abcdfghijklmnpqrsvwxyz-uses-generated'
	),
	references: ['6123456789abcdfghijklmnpqrsvwxyz-generated']
};

// The narinfo that `nix copy --to file://...?compression=zstd` wrote for
// `source`, byte for byte.
const nixWrittenSourceNarInfo = [
	'StorePath: /nix/store/01gahr13mk3p411jhgxk7ab3pnl0c9yv-0001-No-impure-bin-sh.patch',
	'URL: nar/01izajrx8k9gh1irvld1rxdbggcs5i5143maggd6ypl10nimhard.nar.zst',
	'Compression: zstd',
	'FileHash: sha256:01izajrx8k9gh1irvld1rxdbggcs5i5143maggd6ypl10nimhard',
	'FileSize: 1016',
	'NarHash: sha256:0phr7gbi15dqnnnmq2jhs7y02ckskhnzdwj19p7bdwvayrp3in01',
	'NarSize: 1768',
	'References: ',
	'CA: fixed:r:sha256:0phr7gbi15dqnnnmq2jhs7y02ckskhnzdwj19p7bdwvayrp3in01',
	''
].join('\n');

interface SigningKey {
	readonly name: string;
	readonly privateKey: KeyObject;
	readonly publicKey: string;
	readonly secretKey: string;
}

function signingKey(name: string): SigningKey {
	const pair = generateKeyPairSync('ed25519');
	const { d, x } = pair.privateKey.export({ format: 'jwk' });

	if (d === undefined || x === undefined) {
		throw new Error('the test key has no key material');
	}

	const seed = Buffer.from(d, 'base64url');
	const publicHalf = Buffer.from(x, 'base64url');

	return {
		name,
		privateKey: pair.privateKey,
		publicKey: `${name}:${publicHalf.toString('base64')}`,
		secretKey: `${name}:${Buffer.concat([seed, publicHalf]).toString('base64')}`
	};
}

const configuredKey = signingKey('cupboard-configured-1');
const secretFileKey = signingKey('cupboard-secret-file-1');
const untrustedKey = signingKey('cupboard-untrusted-1');

function signature(fingerprint: NixFingerprint, key: SigningKey): string {
	return `${key.name}:${sign(undefined, Buffer.from(fingerprint), key.privateKey).toString('base64')}`;
}

interface PathFixture {
	readonly storePath: StorePathString;
	readonly ca?: string;
	readonly references: readonly string[];
}

const narHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 7));

function narInfo(fixture: PathFixture, signedBy?: SigningKey): string {
	const unsigned = NarInfo.fromFields({
		storePath: fixture.storePath,
		url: 'nar/fixture.nar.zst',
		compression: 'zstd',
		fileHash: narHash.toString(),
		fileSize: 256,
		narHash: narHash.toString(),
		narSize: 512,
		references: fixture.references,
		...(fixture.ca !== undefined && { ca: fixture.ca }),
		sigs: []
	});

	return (
		signedBy === undefined
			? unsigned
			: unsigned.withSignature(signature(unsigned.fingerprint(), signedBy))
	).render();
}

/**
A narinfo file in an archive, and the store path that it describes.
*/
interface ArchiveEntry {
	readonly storePath: StorePathString;
	readonly text: string;
}

function entry(fixture: PathFixture, signedBy?: SigningKey): ArchiveEntry {
	return { storePath: fixture.storePath, text: narInfo(fixture, signedBy) };
}

type Archive = readonly ArchiveEntry[];

const nixWrittenSource: ArchiveEntry = {
	storePath: source.storePath,
	text: nixWrittenSourceNarInfo
};

const contentAddressedArchive: Archive = [nixWrittenSource, entry(flatFile)];

function rootsOf(archive: Archive): readonly StorePathString[] {
	return archive.map(({ storePath }) => storePath);
}

interface ExitStatuses {
	readonly copy: number;
	readonly tar: number;
	readonly verify: number;
}

const succeeding: ExitStatuses = { copy: 0, tar: 0, verify: 0 };

interface RecordedCommand {
	readonly arguments: readonly string[];
	readonly stdin: readonly string[];
}

/**
A child process that exits with `status` as soon as the caller listens for
its exit.
*/
function exitingProcess(status: number): AbortableChildProcessLifecycle {
	return {
		kill: () => true,
		onceError() {
			return;
		},
		onceClose: (listener) => {
			listener(status, undefined);
		}
	};
}

/**
A `nix` process that records its arguments and the paths on its stdin, then
exits with `status` once it has read them. `onStart`, when given, runs before
the paths are read.
*/
function recordingNix(
	recorded: RecordedCommand[],
	status: number,
	onStart?: (arguments_: readonly string[]) => void
): NixCopyDependencies {
	return {
		start: (arguments_): NixCopyProcess => {
			const command = { arguments: ['nix', ...arguments_], stdin: [] };
			const stdin: string[] = command.stdin;
			recorded.push(command);
			onStart?.(arguments_);

			let onClose:
				| ((status: number | null, signal: NodeJS.Signals | undefined) => void)
				| undefined;

			return {
				stdin: new Writable({
					write(chunk: Uint8Array, _encoding, callback) {
						stdin.push(
							...Buffer.from(chunk).toString('utf8').split('\n').filter(Boolean)
						);
						callback();
					},
					final(callback) {
						callback();
						onClose?.(status, undefined);
					}
				}),
				kill: () => true,
				onceError() {
					return;
				},
				onceClose: (listener) => {
					onClose = listener;
				}
			};
		}
	};
}

function writeArchive(target: string, archive: Archive): void {
	for (const { storePath, text } of archive) {
		writeFileSync(
			path.join(target, `${StorePath.hash(storePath)}.narinfo`),
			text
		);
	}
	writeFileSync(path.join(target, 'nix-cache-info'), 'StoreDir: /nix/store\n');
}

/**
Records every command. `tar -cf` writes the archive so that the export can
measure it, `tar -xf` writes `archive` as a `file://` binary cache, and
`nix copy` to a `file://` URL writes the same cache there.
*/
function recordingProcesses(
	recorded: RecordedCommand[],
	statuses: ExitStatuses,
	archive: Archive = contentAddressedArchive
): {
	readonly startTar: TarStarter;
	readonly copy: NixCopyDependencies;
	readonly verify: NixCopyDependencies;
} {
	return {
		startTar: (arguments_) => {
			recorded.push({ arguments: ['tar', ...arguments_], stdin: [] });

			const [mode, file, , target] = arguments_;

			if (mode === '-cf' && file !== undefined && statuses.tar === 0) {
				writeFileSync(file, 'archive bytes');
			}

			if (mode === '-xf' && target !== undefined && statuses.tar === 0) {
				writeArchive(target, archive);
			}

			return exitingProcess(statuses.tar);
		},
		copy: recordingNix(recorded, statuses.copy, (arguments_) => {
			const target = arguments_[arguments_.indexOf('--to') + 1];

			if (target?.startsWith('file:') !== true) {
				return;
			}

			const url = new URL(target);
			url.search = '';
			writeArchive(fileURLToPath(url), archive);
		}),
		verify: recordingNix(recorded, statuses.verify)
	};
}

/**
Runs the real `nix store verify`, so the archive is read the way Nix reads
it. The configuration contains only the test's trusted keys: a configured
public key and a secret key file. Nix's messages go to the test output.
*/
async function realNixVerify(
	directory: string,
	recorded: RecordedCommand[]
): Promise<NixCopyDependencies> {
	const home = path.join(directory, 'nix-home');
	const keyFile = path.join(home, 'secret-file.key');
	const userConfig = path.join(home, 'nix.conf');

	await mkdir(home, { recursive: true });
	await writeFile(keyFile, secretFileKey.secretKey);
	await writeFile(
		userConfig,
		[
			'experimental-features = nix-command',
			`trusted-public-keys = ${configuredKey.publicKey}`,
			`secret-key-files = ${keyFile}`,
			''
		].join('\n')
	);

	return {
		start: (arguments_): NixCopyProcess => {
			recorded.push({ arguments: ['nix', ...arguments_], stdin: [] });

			const child = spawn('nix', [...arguments_], {
				stdio: ['pipe', 'ignore', 'inherit'],
				env: {
					PATH: process.env.PATH,
					HOME: home,
					NIX_CONF_DIR: home,
					NIX_USER_CONF_FILES: userConfig,
					XDG_CACHE_HOME: path.join(home, 'cache'),
					XDG_CONFIG_HOME: path.join(home, 'config'),
					XDG_DATA_HOME: path.join(home, 'data'),
					XDG_STATE_HOME: path.join(home, 'state')
				}
			});

			return { ...observeChildProcess(child), stdin: child.stdin };
		}
	};
}

// Writes an archive where the download step would leave it under `directory`.
async function downloadedArchive(directory: string): Promise<string> {
	const archive = path.join(directory, 'download', derivationArchiveName);

	await mkdir(path.dirname(archive), { recursive: true });
	await writeFile(archive, 'archive bytes');

	return archive;
}

function clock(...times: readonly number[]): () => number {
	const remaining = [...times];

	return () => {
		const time = remaining.shift();

		if (time === undefined) {
			throw new Error('the test clock has no more times');
		}

		return time;
	};
}

const verifyFlags = [
	'nix',
	'store',
	'verify',
	'--quiet',
	'--no-contents',
	'--sigs-needed',
	'1',
	'--recursive'
];

function commandFailure(error: unknown): unknown {
	return error instanceof CommandFailedError
		? { name: error.name, command: error.command, status: error.status }
		: error;
}

describe('derivation closure archives', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-derivation-closure-')
		);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	describe('exportDerivationClosure', () => {
		const derivations = rootsOf(contentAddressedArchive);

		it('checks the closure with Nix, copies it into a zstd file cache, packs the cache into one archive and removes the cache', async () => {
			const recorded: RecordedCommand[] = [];
			const cache = path.join(directory, 'cache');
			const archive = path.join(directory, derivationArchiveName);

			const exported = await exportDerivationClosure(
				derivations,
				directory,
				undefined,
				{
					...recordingProcesses(recorded, succeeding),
					now: clock(0, 100, 1100, 1600)
				}
			);

			expect({
				exported,
				cacheExists: existsSync(cache),
				recorded
			}).toStrictEqual({
				exported: {
					archive,
					archiveBytes: 'archive bytes'.length,
					paths: contentAddressedArchive.length,
					checkMs: 100,
					copyMs: 1000,
					packMs: 500
				},
				cacheExists: false,
				recorded: [
					{ arguments: [...verifyFlags, '--stdin'], stdin: derivations },
					{
						arguments: [
							'nix',
							'copy',
							'--quiet',
							'--to',
							`${pathToFileURL(cache).href}?compression=zstd`,
							'--stdin'
						],
						stdin: derivations
					},
					{
						arguments: ['tar', '-cf', archive, '-C', cache, '.'],
						stdin: []
					}
				]
			});
		});

		it('refuses a closure that Nix refuses before it copies anything', async () => {
			const recorded: RecordedCommand[] = [];
			let error: unknown;

			try {
				await exportDerivationClosure(derivations, directory, undefined, {
					...recordingProcesses(recorded, { ...succeeding, verify: 2 })
				});
			} catch (error_) {
				error = error_;
			}

			expect({
				failure:
					error instanceof DerivationClosureUntrustedError
						? { name: error.name, cause: commandFailure(error.cause) }
						: error,
				commands: recorded.map(({ arguments: command }) =>
					command.slice(0, 3).join(' ')
				)
			}).toStrictEqual({
				failure: {
					name: 'DerivationClosureUntrustedError',
					cause: {
						name: 'CommandFailedError',
						command: 'nix store verify',
						status: 2
					}
				},
				commands: ['nix store verify']
			});
		});
	});

	describe('importDerivationClosure', () => {
		it.each([
			{
				name: 'content-addressed paths, one in a narinfo that Nix wrote',
				archive: contentAddressedArchive
			},
			{
				name: 'a path without a content address that a configured key signed',
				archive: [...contentAddressedArchive, entry(builtOutput, configuredKey)]
			},
			{
				name: 'a path without a content address that the key in a secret key file signed',
				archive: [...contentAddressedArchive, entry(builtOutput, secretFileKey)]
			}
		])(
			'unpacks an archive of $name, checks it with Nix, copies the given paths and removes both copies',
			async ({ archive: entries }) => {
				const recorded: RecordedCommand[] = [];
				const archive = await downloadedArchive(directory);
				const cacheDirectory = path.join(directory, 'cohort-cache');
				const cache = path.join(cacheDirectory, 'cache');
				const roots = rootsOf(entries);

				const imported = await importDerivationClosure(
					archive,
					roots,
					cacheDirectory,
					undefined,
					{
						...recordingProcesses(recorded, succeeding, entries),
						verify: await realNixVerify(directory, recorded),
						now: clock(100, 400, 450, 2450)
					}
				);

				expect({
					imported,
					recorded,
					archiveExists: existsSync(archive),
					cacheExists: existsSync(cacheDirectory)
				}).toStrictEqual({
					imported: {
						archivePaths: entries.length,
						unpackMs: 300,
						verifyMs: 50,
						copyMs: 2000
					},
					recorded: [
						{
							arguments: ['tar', '-xf', archive, '-C', cache],
							stdin: []
						},
						{
							arguments: [
								...verifyFlags,
								'--store',
								pathToFileURL(cache).href,
								'--stdin'
							],
							stdin: []
						},
						{
							arguments: [
								'nix',
								'copy',
								'--quiet',
								'--from',
								pathToFileURL(cache).href,
								'--to',
								'auto',
								'--stdin'
							],
							stdin: roots
						}
					],
					archiveExists: false,
					cacheExists: false
				});
			}
		);

		// A daemon with `require-sigs` off would accept each of these paths from
		// an untrusted client, whatever the client's own configuration says. In
		// the blank-line and empty-field cases, Nix reads no `CA:` field although
		// the text contains one.
		it.each([
			{
				name: 'an unsigned path without a content address',
				archive: [...contentAddressedArchive, entry(builtOutput)]
			},
			{
				name: 'a path signed by a key that is not trusted',
				archive: [...contentAddressedArchive, entry(builtOutput, untrustedKey)]
			},
			{
				name: 'a content address that does not produce its store path',
				archive: [
					...contentAddressedArchive,
					entry({ ...builtOutput, ca: source.ca })
				]
			},
			{
				name: 'a blank line before the CA field',
				archive: [
					nixWrittenSource,
					{
						storePath: flatFile.storePath,
						text: narInfo(flatFile).replace('\nCA: ', '\n\nCA: ')
					}
				]
			},
			{
				name: 'an empty field directly above the CA field',
				archive: [
					nixWrittenSource,
					{
						storePath: flatFile.storePath,
						text: narInfo(flatFile).replace('\nCA: ', '\nJunk:\nCA: ')
					}
				]
			},
			{
				name: 'an unsigned dependency of a signed root',
				archive: [entry(builtDependent, configuredKey), entry(builtOutput)],
				roots: [builtDependent.storePath]
			}
		])(
			'refuses an archive with $name before it copies anything',
			async ({ archive: entries, roots }) => {
				const recorded: RecordedCommand[] = [];
				const archive = await downloadedArchive(directory);
				const cacheDirectory = path.join(directory, 'cohort-cache');
				let error: unknown;

				try {
					await importDerivationClosure(
						archive,
						roots ?? rootsOf(entries),
						cacheDirectory,
						undefined,
						{
							...recordingProcesses(recorded, succeeding, entries),
							verify: await realNixVerify(directory, recorded)
						}
					);
				} catch (error_) {
					error = error_;
				}

				expect({
					failure:
						error instanceof DerivationClosureImportError
							? { name: error.name, cause: commandFailure(error.cause) }
							: error,
					commands: recorded.map(({ arguments: command }) =>
						command.slice(0, 3).join(' ')
					),
					archiveExists: existsSync(archive),
					cacheExists: existsSync(cacheDirectory)
				}).toStrictEqual({
					failure: {
						name: 'DerivationClosureImportError',
						cause: {
							name: 'CommandFailedError',
							command: 'nix store verify',
							status: 2
						}
					},
					commands: [`tar -xf ${archive}`, 'nix store verify'],
					archiveExists: false,
					cacheExists: false
				});
			}
		);

		it.each([
			{
				name: 'the archive does not unpack',
				statuses: { ...succeeding, tar: 2 },
				cause: { name: 'CommandFailedError', command: 'tar', status: 2 },
				commands: 1
			},
			{
				name: 'Nix refuses to copy a path',
				statuses: { ...succeeding, copy: 1 },
				cause: { name: 'CommandFailedError', command: 'nix copy', status: 1 },
				commands: 3
			}
		])(
			'fails and removes both copies when $name',
			async ({ statuses, cause, commands }) => {
				const recorded: RecordedCommand[] = [];
				const archive = await downloadedArchive(directory);
				const cacheDirectory = path.join(directory, 'cohort-cache');
				let error: unknown;

				try {
					await importDerivationClosure(
						archive,
						rootsOf(contentAddressedArchive),
						cacheDirectory,
						undefined,
						recordingProcesses(recorded, statuses)
					);
				} catch (error_) {
					error = error_;
				}

				expect({
					failure:
						error instanceof DerivationClosureImportError
							? {
									name: error.name,
									archive: error.archive,
									cause: commandFailure(error.cause)
								}
							: error,
					commands: recorded.length,
					archiveExists: existsSync(archive),
					cacheExists: existsSync(cacheDirectory)
				}).toStrictEqual({
					failure: { name: 'DerivationClosureImportError', archive, cause },
					commands,
					archiveExists: false,
					cacheExists: false
				});
			}
		);
	});
});
