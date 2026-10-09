import { randomUUID } from 'node:crypto';
import {
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheAccessMode,
	cacheNameSchema,
	type CacheScope,
	rootNameSchema,
	storePathSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ProgramOptions } from '../cli.ts';
import type { TokenProvider } from '../client/credentials.ts';
import {
	CliAbortError,
	CommandPayloadRequiredError,
	CupboardHttpError,
	InvalidStoreUriError,
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError,
	ReadCredentialPairError,
	ReceiptFileRequiresStoreError,
	ReferenceSourcePairError,
	ReferenceSourceReadRefusedError,
	RootRetentionOptionConflictError,
	RunRootRetentionWithoutRunRootError,
	RunRootTtlWithoutRunRootError
} from '../errors.ts';
import type { PushStore } from '../push/push.ts';

import {
	observedCopiesFrom,
	parsePathFile,
	pushCommandAuthorizationDetails,
	receiptBuildStore,
	ReferenceReceiptOptionError,
	registerPushCommand,
	resolvePushPath,
	validateRetentionChoice
} from './push.ts';

const rootName = (value: string) => rootNameSchema.parse(value);
const defaultCache: CacheScope = { kind: 'default' };

describe('resolvePushPath', () => {
	const storePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

	it.each([
		{
			name: 'a store path passes through without touching the filesystem',
			path: storePath,
			realpath: () => {
				throw new Error('realpath should not be consulted for a store path');
			},
			expected: storePath
		},
		{
			name: 'a symlink to a store path resolves to its target',
			path: './result',
			realpath: () => storePath,
			expected: storePath
		},
		{
			name: 'a file inside a store path resolves to the containing store path',
			path: './result/bin/app',
			realpath: () => `${storePath}/bin/app`,
			expected: storePath
		},
		{
			name: 'a symlink outside the store resolves to its non-store target',
			path: './result',
			realpath: () => '/tmp/out',
			expected: '/tmp/out'
		},
		{
			name: 'a location the filesystem cannot resolve passes through',
			path: './missing',
			realpath: () => {
				throw new Error('no such file');
			},
			expected: './missing'
		}
	])('$name', ({ path: value, realpath, expected }) => {
		expect(resolvePushPath(value, realpath)).toBe(expected);
	});
});

describe('parsePathFile', () => {
	it.each([
		{
			name: 'newline-delimited paths',
			contents: '/nix/store/a\n/nix/store/b\n',
			expected: ['/nix/store/a', '/nix/store/b']
		},
		{
			name: 'lines with surrounding whitespace and CRLF endings',
			contents: ' /nix/store/a \r\n\t/nix/store/b\r\n',
			expected: ['/nix/store/a', '/nix/store/b']
		},
		{
			name: 'blank lines dropped',
			contents: '\n/nix/store/a\n\n\n/nix/store/b\n\n',
			expected: ['/nix/store/a', '/nix/store/b']
		},
		{
			name: 'an empty file',
			contents: '',
			expected: []
		}
	])('parses $name', ({ contents, expected }) => {
		expect(parsePathFile(contents)).toStrictEqual(expected);
	});
});

describe('validateRetentionChoice', () => {
	it.each([
		{
			name: '--no-retain combined with --permanent',
			options: { retain: false, permanent: true },
			error: NoRetainConflictError
		},
		{
			name: '--ttl combined with --permanent',
			options: { ttl: ttlSecondsSchema.parse(3600), permanent: true },
			error: RootRetentionOptionConflictError
		},
		{
			name: '--run-root-permanent without --run-root',
			options: { runRootPermanent: true },
			error: RunRootRetentionWithoutRunRootError
		},
		{
			name: '--run-root-ttl combined with --run-root-permanent',
			options: {
				runRoot: rootName('ci/run-1'),
				runRootTtl: ttlSecondsSchema.parse(3600),
				runRootPermanent: true
			},
			error: RootRetentionOptionConflictError
		},
		{
			name: '--no-retain combined with --root',
			options: { retain: false, root: rootName('main') },
			error: NoRetainConflictError
		},
		{
			name: '--no-retain combined with --ttl',
			options: { retain: false, ttl: ttlSecondsSchema.parse(1_209_600) },
			error: NoRetainConflictError
		},
		{
			name: 'a mutating GitHub OIDC push naming neither --root nor --no-retain',
			options: { githubOidc: true },
			error: OidcRetentionChoiceRequiredError
		},
		{
			name: '--run-root-ttl without --run-root',
			options: { runRootTtl: ttlSecondsSchema.parse(3600) },
			error: RunRootTtlWithoutRunRootError
		}
	])('rejects $name', ({ options, error }) => {
		expect(() => {
			validateRetentionChoice(options);
		}).toThrow(error);
	});

	it.each([
		{ name: 'a named root', options: { root: rootName('main') } },
		{
			name: 'permanent publication and run roots',
			options: {
				root: rootName('main'),
				permanent: true,
				runRoot: rootName('ci/run-1'),
				runRootPermanent: true
			}
		},
		{ name: 'explicit unretained publication', options: { retain: false } },
		{
			name: 'a GitHub OIDC dry run naming neither',
			options: { githubOidc: true, dryRun: true }
		},
		{ name: 'an interactive push naming neither', options: {} },
		{
			name: 'explicit unretained publication with a run root',
			options: {
				retain: false,
				runRoot: rootName('ci/run-1'),
				runRootTtl: ttlSecondsSchema.parse(3600)
			}
		}
	])('accepts $name', ({ options }) => {
		expect(() => {
			validateRetentionChoice(options);
		}).not.toThrow();
	});
});

describe('observedCopiesFrom', () => {
	it('parses the copy observations written by a supervising build', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-copies-'));
		const copiedFromFile = path.join(directory, 'observed-copies.json');
		const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

		try {
			writeFileSync(
				copiedFromFile,
				JSON.stringify({ [appPath]: ['https://cache.example.test'] })
			);

			expect([
				...((await observedCopiesFrom(copiedFromFile)) ?? [])
			]).toStrictEqual([[appPath, ['https://cache.example.test']]]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('returns undefined when the run supplied no file', async () => {
		await expect(observedCopiesFrom(undefined)).resolves.toBeUndefined();
	});

	it('rejects a file that does not describe copy observations', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-copies-'));
		const copiedFromFile = path.join(directory, 'observed-copies.json');

		try {
			writeFileSync(copiedFromFile, JSON.stringify({ 'not a path': [] }));

			await expect(observedCopiesFrom(copiedFromFile)).rejects.toBeInstanceOf(
				z.ZodError
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('receiptBuildStore', () => {
	it.each([
		{
			name: 'no receipt file',
			options: { store: 'ssh-ng://builder.example' },
			expected: undefined
		},
		{
			name: 'a receipt file with a selected store and no existing paths',
			options: {
				receiptFile: '/runner/temp/receipt.json',
				store: 'ssh-ng://builder.example',
				alreadyHeld: false as const,
				claimable: false as const
			},
			expected: 'ssh-ng://builder.example'
		},
		{
			name: 'a receipt file with the local automatic store',
			options: {
				receiptFile: '/runner/temp/receipt.json',
				store: 'auto',
				alreadyHeld: false as const,
				claimable: false as const
			},
			expected: 'auto'
		},
		{
			name: 'a receipt file with a selected store and existing paths',
			options: {
				receiptFile: '/runner/temp/receipt.json',
				store: 'ssh-ng://builder.example',
				alreadyHeld: ['/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'],
				claimable: ['/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-lib']
			},
			expected: 'ssh-ng://builder.example'
		}
	])('returns the build store for $name', ({ options, expected }) => {
		expect(receiptBuildStore(options)).toBe(expected);
	});

	it('requires a selected store when writing a receipt file', () => {
		expect(() =>
			receiptBuildStore({ receiptFile: '/runner/temp/receipt.json' })
		).toThrow(ReceiptFileRequiresStoreError);
	});

	it('records store metadata without legacy build-claim inputs', () => {
		expect(
			receiptBuildStore({
				receiptFile: '/runner/temp/receipt.json',
				store: 'ssh-ng://builder.example'
			})
		).toBe('ssh-ng://builder.example');
	});
});

const fixedToken: TokenProvider = {
	get: () => Promise.resolve('test-token'),
	refresh: () => Promise.resolve('test-token')
};

function unexpectedStoreCall(method: string): never {
	throw new Error(`unexpected call to ${method} on the test store`);
}

function storeWithEveryPath(): PushStore {
	return {
		storeKind: 'local-filesystem',
		resolveClosure: () => unexpectedStoreCall('resolveClosure'),
		queryValidPathsInfo: (storePaths) =>
			Promise.resolve(
				storePaths.map((storePath) => ({
					storePath: storePathSchema.parse(storePath),
					narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, 1)),
					narSize: 1,
					references: [],
					signatures: [],
					ultimate: true
				}))
			),
		narFromPath: () => unexpectedStoreCall('narFromPath')
	};
}

// A push that gets past validation contacts the cache and the reference
// source. The tests that check what validation accepts pass the command an
// already-aborted signal, which is what an interrupt gives a real push. The
// run then stops at its first remote call and makes no DNS lookup.
const interrupted: ProgramOptions = {
	signal: AbortSignal.abort(new CliAbortError())
};

interface PushRun {
	readonly result: unknown;
	// The cache for each token provider request, in order.
	readonly tokenProviderRequests: readonly CacheScope[];
	readonly openStoreCalls: number;
}

async function parsePush(
	arguments_: readonly string[],
	programOptions: ProgramOptions = {},
	queriedPaths?: string[][]
): Promise<PushRun> {
	const tokenProviderRequests: CacheScope[] = [];
	let openStoreCalls = 0;
	const program = new Command();

	program.exitOverride();
	program.configureOutput({
		writeErr() {
			return;
		},
		writeOut() {
			return;
		}
	});
	registerPushCommand(program, programOptions, {
		authenticate: (client) => {
			tokenProviderRequests.push(client.cache);

			return Promise.resolve(fixedToken);
		},
		openStore: () => {
			openStoreCalls += 1;
			const store = storeWithEveryPath();
			return {
				...store,
				queryValidPathsInfo: (paths) => {
					queriedPaths?.push([...paths]);
					return store.queryValidPathsInfo(paths);
				}
			};
		}
	});

	let result: unknown;
	try {
		await program.parseAsync(['push', ...arguments_], { from: 'user' });
		result = { kind: 'parsed' as const };
	} catch (error: unknown) {
		result = error;
	}

	return { result, tokenProviderRequests, openStoreCalls };
}

describe('pushCommandAuthorizationDetails', () => {
	it.each([
		{
			name: 'a dry run requests only the read-only preview operation',
			options: { dryRun: true, root: rootName('main') },
			expected: [
				{
					type: 'cupboard_cache',
					actions: ['upload:preview'],
					cache: defaultCache
				}
			]
		},
		{
			name: 'a rooted push requests the full upload grant with its root',
			options: { root: rootName('main') },
			expected: [
				{
					type: 'cupboard_cache',
					actions: [
						'upload:negotiate',
						'upload:status',
						'upload:commit',
						'attestation:negotiate',
						'attestation:attach',
						'root:set'
					],
					cache: defaultCache,
					root: rootName('main')
				}
			]
		},
		{
			name: 'an unattested push omits the attestation operations',
			options: { attest: false },
			expected: [
				{
					type: 'cupboard_cache',
					actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
					cache: defaultCache
				}
			]
		},
		{
			name: 'a push naming a run root requests its attach grant beside the push grant',
			options: { root: rootName('main'), runRoot: rootName('ci/run-1') },
			expected: [
				{
					type: 'cupboard_cache',
					actions: [
						'upload:negotiate',
						'upload:status',
						'upload:commit',
						'attestation:negotiate',
						'attestation:attach',
						'root:set'
					],
					cache: defaultCache,
					root: rootName('main')
				},
				{
					type: 'cupboard_cache',
					actions: ['root:attach'],
					cache: defaultCache,
					root: rootName('ci/run-1')
				}
			]
		},
		{
			name: 'a dry run naming a run root still requests only preview',
			options: { dryRun: true, runRoot: rootName('ci/run-1') },
			expected: [
				{
					type: 'cupboard_cache',
					actions: ['upload:preview'],
					cache: defaultCache
				}
			]
		}
	])('$name', ({ options, expected }) => {
		expect(
			pushCommandAuthorizationDetails(options, defaultCache)
		).toStrictEqual(expected);
	});
});

describe('push command', () => {
	it.each([
		{ suffix: '', cache: defaultCache },
		{
			suffix: '/cache/release',
			cache: { kind: 'named', name: cacheNameSchema.parse('release') }
		}
	])(
		'combines target path files and arguments for $cache.kind caches',
		async ({ suffix, cache }) => {
			const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
			const file = path.join(directory, 'paths.txt');
			const argumentPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
			const filePaths = [
				'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-lib',
				'/nix/store/2123456789abcdfghijklmnpqrsvwxyz-runtime'
			];
			writeFileSync(file, `${filePaths.join('\n')}\n`);
			const queriedPaths: string[][] = [];

			try {
				const run = await parsePush(
					[
						`https://cache.example.workers.dev/t/acme${suffix}`,
						argumentPath,
						'--paths-file',
						file,
						'--dry-run'
					],
					interrupted,
					queriedPaths
				);
				expect({ run, queriedPaths }).toStrictEqual({
					run: {
						result: new CliAbortError(),
						tokenProviderRequests: [cache],
						openStoreCalls: 1
					},
					queriedPaths: [[argumentPath, ...filePaths]]
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

	it('reads a large target list without positional path arguments', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const file = path.join(directory, 'paths.txt');
		const paths = Array.from(
			{ length: 40_000 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-manifest-path`
		);
		writeFileSync(file, `${paths.join('\n')}\n`);
		const queriedPaths: string[][] = [];

		try {
			const run = await parsePush(
				[
					'https://cache.example.workers.dev/t/acme',
					'--paths-file',
					file,
					'--dry-run'
				],
				interrupted,
				queriedPaths
			);
			expect({ run, queriedPaths }).toStrictEqual({
				run: {
					result: new CliAbortError(),
					tokenProviderRequests: [defaultCache],
					openStoreCalls: 1
				},
				queriedPaths: [paths]
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{
			flags: ['--root', 'main'],
			result: new CliAbortError(),
			tokenProviderRequests: [defaultCache]
		},
		{
			flags: ['--dry-run'],
			result: new CommandPayloadRequiredError('a store path'),
			tokenProviderRequests: []
		}
	])(
		'validates an empty target file with $flags',
		async ({ flags, result, tokenProviderRequests }) => {
			const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
			const file = path.join(directory, 'paths.txt');
			writeFileSync(file, '\n');
			try {
				const run = await parsePush(
					[
						'https://cache.example.workers.dev/t/acme',
						'--paths-file',
						file,
						...flags
					],
					interrupted
				);
				expect(run).toStrictEqual({
					result,
					tokenProviderRequests,
					openStoreCalls: 0
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

	it('reports an unreadable target file before authenticating', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const file = path.join(directory, 'missing.txt');
		try {
			const run = await parsePush([
				'https://cache.example.workers.dev/t/acme',
				'--paths-file',
				file
			]);
			const failure = run.result;
			expect({
				...run,
				result:
					failure instanceof Error && 'code' in failure
						? { code: failure.code, message: failure.message }
						: failure
			}).toStrictEqual({
				result: {
					code: 'ENOENT',
					message: `ENOENT: no such file or directory, open '${file}'`
				},
				tokenProviderRequests: [],
				openStoreCalls: 0
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(['--reference-paths-file', '--reference-manifest'])(
		'accepts a %s publication past positional parsing',
		async (referenceOption) => {
			const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
			const file = path.join(directory, 'references.txt');
			writeFileSync(
				file,
				'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime\n'
			);

			if (referenceOption === '--reference-manifest') {
				const storePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';
				const hash = NixSha256Hash.fromDigest(Buffer.alloc(32)).toString();
				writeFileSync(
					file,
					JSON.stringify({
						version: 1,
						paths: [
							{
								storePath,
								kind: 'intermediate',
								source: 'https://cache.example.workers.dev/t/acme/reuse/reuse',
								narinfo: NarInfo.fromFields({
									storePath,
									url: 'nar/runtime.nar.zst',
									compression: 'zstd',
									fileHash: hash,
									fileSize: 1,
									narHash: hash,
									narSize: 1,
									references: [],
									sigs: []
								}).render()
							}
						]
					})
				);
			}
			try {
				const run = await parsePush(
					[
						'https://cache.example.workers.dev/t/acme',
						referenceOption,
						file,
						...(referenceOption === '--reference-manifest'
							? []
							: [
									'--reference-source',
									'https://cache.example.workers.dev/t/acme/reuse/reuse'
								]),
						'--dry-run'
					],
					interrupted
				);

				// The run reached its first remote call, so positional parsing accepted
				// the reference paths as a publication in their own right.
				expect(run).toStrictEqual({
					result: new CliAbortError(),
					tokenProviderRequests: [defaultCache],
					openStoreCalls: 0
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

	it('rejects a publication with no paths of any kind', async () => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'--dry-run'
		]);

		expect(run).toStrictEqual({
			result: new CommandPayloadRequiredError('a store path'),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it('accepts an empty named-root replacement past publication validation', async () => {
		const run = await parsePush(
			['https://cache.example.workers.dev/t/acme', '--root', 'main'],
			interrupted
		);

		// The run reached its first remote call, so a root replacement with no
		// paths is not an empty publication.
		expect(run).toStrictEqual({
			result: new CliAbortError(),
			tokenProviderRequests: [defaultCache],
			openStoreCalls: 0
		});
	});

	it('requests a token provider for a named cache URL and opens the injected store', async () => {
		const run = await parsePush(
			[
				'https://cache.example.workers.dev/t/acme/cache/release',
				'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
			],
			interrupted
		);

		expect(run).toStrictEqual({
			result: new CliAbortError(),
			tokenProviderRequests: [
				{ kind: 'named', name: cacheNameSchema.parse('release') }
			],
			openStoreCalls: 1
		});
	});

	it('rejects --no-retain combined with --root before authenticating', async () => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--no-retain',
			'--root',
			'main'
		]);

		expect(run).toStrictEqual({
			result: new NoRetainConflictError('--root'),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it('rejects a mutating GitHub OIDC push with neither --root nor --no-retain', async () => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--github-oidc'
		]);

		expect(run).toStrictEqual({
			result: new OidcRetentionChoiceRequiredError(),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it('rejects a --store URI without an ssh-ng destination', async () => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--store',
			'daemon'
		]);

		expect(run).toStrictEqual({
			result: new InvalidStoreUriError('daemon'),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it('parses an ssh-ng --store URI and still validates retention first', async () => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--store',
			'ssh-ng://build@example.test',
			'--no-retain',
			'--root',
			'main'
		]);

		expect(run).toStrictEqual({
			result: new NoRetainConflictError('--root'),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it('accepts the automatic local store for a receipt-producing push', async () => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--store',
			'auto',
			'--no-retain',
			'--root',
			'main'
		]);

		expect(run).toStrictEqual({
			result: new NoRetainConflictError('--root'),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it('rejects --run-root-ttl without --run-root before authenticating', async () => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--run-root-ttl',
			'1h'
		]);

		expect(run).toStrictEqual({
			result: new RunRootTtlWithoutRunRootError(),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it.each([
		{
			name: '--reference-paths-file without --reference-source',
			extraArguments: ['--reference-paths-file', 'references.txt']
		},
		{
			name: '--reference-source without --reference-paths-file',
			extraArguments: [
				'--reference-source',
				'https://cache.example.workers.dev/t/acme/reuse/reuse'
			]
		}
	])('rejects $name', async ({ extraArguments }) => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			...extraArguments
		]);

		expect(run).toStrictEqual({
			result: new ReferenceSourcePairError(),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it.each([
		{
			name: 'missing reference inputs',
			extraArguments: ['--reference-receipt-file', 'reference.json'],
			reason: 'source' as const
		},
		{
			name: 'a missing reference source',
			extraArguments: [
				'--reference-receipt-file',
				'reference.json',
				'--reference-paths-file',
				'references.txt'
			],
			reason: 'source' as const
		},
		{
			name: 'a missing reference paths file',
			extraArguments: [
				'--reference-receipt-file',
				'reference.json',
				'--reference-source',
				'https://cache.example.workers.dev/t/acme'
			],
			reason: 'source' as const
		},
		{
			name: 'a build receipt at the same time',
			extraArguments: [
				'--reference-receipt-file',
				'reference.json',
				'--receipt-file',
				'build.json'
			],
			reason: 'conflict' as const
		}
	])(
		'rejects $name before authenticating',
		async ({ extraArguments, reason }) => {
			const run = await parsePush([
				'https://cache.example.workers.dev/t/acme',
				'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				...extraArguments
			]);

			expect(run).toStrictEqual({
				result: new ReferenceReceiptOptionError(reason),
				tokenProviderRequests: [],
				openStoreCalls: 0
			});
		}
	);

	it.each([
		['--read-user', 'reader'],
		['--read-password', 'secret']
	])('rejects an unpaired %s before authenticating', async (option, value) => {
		const run = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			option,
			value
		]);

		expect(run).toStrictEqual({
			result: new ReadCredentialPairError(),
			tokenProviderRequests: [],
			openStoreCalls: 0
		});
	});

	it.each([
		{
			name: 'a target that is not a store path',
			pushArguments: (_directory: string, missing: string) => [
				'https://cache.example.workers.dev/t/acme',
				missing
			]
		},
		{
			name: 'a non-store path that follows a possible cache name',
			// A random name cannot match an entry in the working directory, so the
			// command treats it as a possible cache name.
			pushArguments: (_directory: string, missing: string) => [
				'https://cache.example.workers.dev/t/acme',
				`cache-${randomUUID()}`,
				missing
			]
		},
		{
			name: 'a reference paths file listing a non-store path',
			pushArguments: (directory: string, missing: string) => {
				const file = path.join(directory, 'references.txt');
				writeFileSync(
					file,
					`/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime\n${missing}\n`
				);

				return [
					'https://cache.example.workers.dev/t/acme',
					'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
					'--reference-paths-file',
					file,
					'--reference-source',
					'https://cache.example.workers.dev/t/acme/reuse/reuse'
				];
			}
		},
		{
			name: 'a target paths file listing a non-store path',
			pushArguments: (directory: string, missing: string) => {
				const file = path.join(directory, 'paths.txt');
				writeFileSync(file, `${missing}\n`);
				return [
					'https://cache.example.workers.dev/t/acme',
					'--paths-file',
					file
				];
			}
		},
		{
			name: 'an intermediate paths file listing a non-store path',
			pushArguments: (directory: string, missing: string) => {
				const file = path.join(directory, 'intermediates.txt');
				writeFileSync(
					file,
					`/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime\n${missing}\n`
				);

				return [
					'https://cache.example.workers.dev/t/acme',
					'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
					'--closure',
					'--intermediate-paths-file',
					file
				];
			}
		}
	])('rejects $name before authenticating', async ({ pushArguments }) => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const missing = path.join(directory, 'missing');

		try {
			const run = await parsePush(pushArguments(directory, missing));

			expect(run).toStrictEqual({
				result: new InvalidStorePathError(missing),
				tokenProviderRequests: [],
				openStoreCalls: 0
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rejects a symlink argument that resolves outside the store before authenticating', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const target = path.join(directory, 'out');
		const link = path.join(directory, 'result');
		writeFileSync(target, 'artefact');
		symlinkSync(target, link);

		try {
			const run = await parsePush([
				'https://cache.example.workers.dev/t/acme',
				link
			]);

			expect(run).toStrictEqual({
				result: new InvalidStorePathError(realpathSync(target)),
				tokenProviderRequests: [],
				openStoreCalls: 0
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(['--paths-file', '--intermediate-paths-file'])(
		'rejects %s listing a symlink outside the store before authenticating',
		async (option) => {
			const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
			const target = path.join(directory, 'out');
			const link = path.join(directory, 'intermediate');
			const file = path.join(directory, 'intermediates.txt');
			writeFileSync(target, 'artefact');
			symlinkSync(target, link);
			writeFileSync(file, `${link}\n`);

			try {
				const run = await parsePush([
					'https://cache.example.workers.dev/t/acme',
					'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
					option,
					file
				]);

				expect(run).toStrictEqual({
					result: new InvalidStorePathError(realpathSync(target)),
					tokenProviderRequests: [],
					openStoreCalls: 0
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);
});

async function requestedAuthority(
	referenceArguments: (directory: string) => readonly string[],
	accessOf: (url: string) => CacheAccessMode
): Promise<{
	readonly requested: readonly unknown[];
	readonly probed: readonly string[];
}> {
	const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
	const requested: unknown[] = [];
	const probed: string[] = [];
	const program = new Command();

	program.exitOverride();
	registerPushCommand(program, interrupted, {
		authenticate: (_client, options) => {
			requested.push(options.authorizationDetails);

			return Promise.resolve(fixedToken);
		},
		fetchCacheAccess: (url) => {
			probed.push(url.href);

			return Promise.resolve(accessOf(url.href));
		}
	});

	try {
		await program.parseAsync(
			[
				'push',
				'https://cache.example.workers.dev/t/acme',
				'--no-attest',
				'--no-retain',
				...referenceArguments(directory)
			],
			{ from: 'user' }
		);
	} catch {
		// The interrupted run stops at its first remote call.
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}

	return { requested, probed };
}

function referencePathsArguments(source: string) {
	return (directory: string): readonly string[] => {
		const referencePathsFile = path.join(directory, 'reference-paths.txt');
		writeFileSync(
			referencePathsFile,
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app\n'
		);

		return [
			'--reference-paths-file',
			referencePathsFile,
			'--reference-source',
			source
		];
	};
}

function referenceManifestArguments(
	entries: readonly { readonly name: string; readonly source: string }[]
) {
	return (directory: string): readonly string[] => {
		const manifest = path.join(directory, 'reference-manifest.json');
		const hash = NixSha256Hash.fromDigest(Buffer.alloc(32)).toString();
		const paths = entries.map(({ name, source }, index) => {
			const storePath = storePathSchema.parse(
				`/nix/store/${String(index)}123456789abcdfghijklmnpqrsvwxyz-${name}`
			);

			return {
				storePath,
				source,
				kind: 'intermediate',
				narinfo: NarInfo.fromFields({
					storePath,
					url: `nar/${name}.nar.zst`,
					compression: 'zstd',
					narHash: hash,
					narSize: 20,
					fileHash: hash,
					fileSize: 10,
					references: [],
					sigs: []
				}).render()
			};
		});
		writeFileSync(manifest, JSON.stringify({ version: 1, paths }));

		return ['--reference-manifest', manifest];
	};
}

describe('reference source read authority', () => {
	const pushGrant = {
		type: 'cupboard_cache',
		actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
		cache: defaultCache
	};
	const pullRequestView =
		'https://cache.example.workers.dev/t/acme/reuse/pull-requests';
	const privateCache = 'https://cache.example.workers.dev/t/acme/cache/falcon';
	const publicCache = 'https://cache.example.workers.dev/t/acme/cache/releases';
	const viewGrant = {
		type: 'cupboard_view',
		actions: ['view:content-read'],
		view: 'pull-requests'
	};
	const cacheGrant = {
		type: 'cupboard_cache',
		actions: ['cache:content-read'],
		cache: { kind: 'named', name: 'falcon' }
	};

	it.each([
		{
			name: 'a private reuse view adds a view read grant',
			source: pullRequestView,
			access: 'private' as const,
			extra: [viewGrant]
		},
		{
			name: 'a private destination needs no extra read grant',
			source: 'https://cache.example.workers.dev/t/acme',
			access: 'private' as const,
			extra: []
		},
		{
			name: 'a private named cache adds a cache read grant',
			source: privateCache,
			access: 'private' as const,
			extra: [cacheGrant]
		},
		{
			name: 'a public reuse view keeps the destination grant alone',
			source: pullRequestView,
			access: 'public' as const,
			extra: []
		}
	])('$name', async ({ source, access, extra }) => {
		expect(
			await requestedAuthority(referencePathsArguments(source), () => access)
		).toStrictEqual({
			requested: [[pushGrant, ...extra]],
			probed:
				source === 'https://cache.example.workers.dev/t/acme' ? [] : [source]
		});
	});

	it('adds a read grant for each private source in a reference manifest', async () => {
		const run = await requestedAuthority(
			referenceManifestArguments([
				{ name: 'app', source: pullRequestView },
				{ name: 'lib', source: publicCache },
				{ name: 'tool', source: pullRequestView },
				{ name: 'data', source: privateCache }
			]),
			(url) => (url === publicCache ? 'public' : 'private')
		);

		expect(run).toStrictEqual({
			requested: [[pushGrant, viewGrant, cacheGrant]],
			probed: [pullRequestView, publicCache, privateCache]
		});
	});
});

describe('a refused reference source read grant', () => {
	const source = 'https://cache.example.workers.dev/t/acme/reuse/pull-requests';
	const refusal = new CupboardHttpError(
		'POST',
		'/t/acme/oauth/token',
		400,
		JSON.stringify({
			error: 'invalid_authorization_details',
			problem: 'not-permitted'
		})
	);

	it.each([
		{
			access: 'private' as const,
			expected: new ReferenceSourceReadRefusedError([new URL(source)], {
				cause: refusal
			})
		},
		{ access: 'public' as const, expected: refusal }
	])(
		'reports the refusal of a push from a $access source',
		async ({ access, expected }) => {
			const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
			const program = new Command();

			program.exitOverride();
			registerPushCommand(program, interrupted, {
				authenticate: () => Promise.reject(refusal),
				fetchCacheAccess: () => Promise.resolve(access)
			});

			let result: unknown;

			try {
				await program.parseAsync(
					[
						'push',
						'https://cache.example.workers.dev/t/acme',
						'--no-attest',
						'--no-retain',
						...referencePathsArguments(source)(directory)
					],
					{ from: 'user' }
				);
			} catch (error: unknown) {
				result = error;
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}

			expect(result).toStrictEqual(expected);
		}
	);
});

describe('push compatibility options', () => {
	it('accepts obsolete options without listing them in ordinary help', () => {
		const program = new Command();
		registerPushCommand(program);
		const command = program.commands.find((entry) => entry.name() === 'push');
		expect(command).toBeDefined();
		if (command === undefined) {
			throw new Error('The push command must be registered');
		}
		const flags = [
			'--already-held',
			'--no-already-held',
			'--claimable',
			'--no-claimable'
		];
		const help = command.helpInformation();
		command.parseOptions([
			'--already-held',
			'/nix/store/a',
			'--claimable',
			'/nix/store/b'
		]);
		const { alreadyHeld, claimable } = command.opts<{
			alreadyHeld: string[];
			claimable: string[];
		}>();
		expect({
			visible: flags.map((flag) => help.includes(flag)),
			alreadyHeld,
			claimable
		}).toStrictEqual({
			visible: [false, false, false, false],
			alreadyHeld: ['/nix/store/a'],
			claimable: ['/nix/store/b']
		});
	});
});
