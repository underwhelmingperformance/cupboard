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
import { rootNameSchema, ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ProgramOptions } from '../cli.ts';
import {
	BuildStoreRequiresAlreadyHeldError,
	BuildStoreRequiresClaimableError,
	CliAbortError,
	EmptyPublicationError,
	InvalidStoreUriError,
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError,
	ReadCredentialPairError,
	ReceiptFileRequiresStoreError,
	ReferenceSourcePairError,
	RunRootTtlWithoutRunRootError
} from '../errors.ts';

import {
	observedCopiesFrom,
	parsePathFile,
	pushCommandAuthorizationDetails,
	receiptBuildStore,
	registerPushCommand,
	resolvePushPath,
	validateRetentionChoice
} from './push.ts';

const rootName = (value: string) => rootNameSchema.parse(value);

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
		{ name: 'explicit unretained publication', options: { retain: false } },
		{
			name: 'a GitHub OIDC dry run naming neither',
			options: { githubOidc: true, dryRun: true }
		},
		{ name: 'an interactive push naming neither', options: {} },
		// A run root is independent of the target-root choice: an unretained
		// push may still bind one, attaching its commits to the run root while
		// declaring no target root.
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
	it('reads the copies a supervising build recorded', async () => {
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

	it('records no copy for a run that supplied no file', async () => {
		await expect(observedCopiesFrom(undefined)).resolves.toBeUndefined();
	});

	it('refuses a file that does not describe observed copies', async () => {
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
			name: 'a receipt file with a selected store and existing paths',
			options: {
				receiptFile: '/runner/temp/receipt.json',
				store: 'ssh-ng://builder.example',
				alreadyHeld: ['/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'],
				claimable: ['/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-lib']
			},
			expected: 'ssh-ng://builder.example'
		}
	])('resolves $name', ({ options, expected }) => {
		expect(receiptBuildStore(options)).toBe(expected);
	});

	it('requires a selected store when writing a receipt file', () => {
		expect(() =>
			receiptBuildStore({ receiptFile: '/runner/temp/receipt.json' })
		).toThrow(ReceiptFileRequiresStoreError);
	});

	it('requires the caller to state which paths the build store already held', () => {
		expect(() =>
			receiptBuildStore({
				receiptFile: '/runner/temp/receipt.json',
				store: 'ssh-ng://builder.example'
			})
		).toThrow(BuildStoreRequiresAlreadyHeldError);
	});

	it('requires claimable paths when recording a selected build store', () => {
		expect(() =>
			receiptBuildStore({
				receiptFile: '/runner/temp/receipt.json',
				store: 'ssh-ng://builder.example',
				alreadyHeld: false
			})
		).toThrow(BuildStoreRequiresClaimableError);
	});
});

function silentProgram(programOptions: ProgramOptions): Command {
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
	registerPushCommand(program, programOptions);

	return program;
}

// A push that gets past validation contacts the cache and the reference
// source. The tests that check what validation accepts pass the command an
// already-aborted signal, which is what an interrupt gives a real push. The
// run then stops at its first remote call and makes no DNS lookup.
const interrupted: ProgramOptions = {
	signal: AbortSignal.abort(new CliAbortError())
};

async function parsePush(
	arguments_: readonly string[],
	programOptions: ProgramOptions = {}
): Promise<unknown> {
	try {
		await silentProgram(programOptions).parseAsync(['push', ...arguments_], {
			from: 'user'
		});

		return { kind: 'parsed' as const };
	} catch (error: unknown) {
		return error;
	}
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
					cache: '_default'
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
					cache: '_default',
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
					cache: '_default'
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
					cache: '_default',
					root: rootName('main')
				},
				{
					type: 'cupboard_cache',
					actions: ['root:attach'],
					cache: '_default',
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
					cache: '_default'
				}
			]
		}
	])('$name', ({ options, expected }) => {
		expect(pushCommandAuthorizationDetails(options, '_default')).toStrictEqual(
			expected
		);
	});
});

describe('push command', () => {
	it('accepts a reference-file-only publication past positional parsing', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const file = path.join(directory, 'references.txt');
		writeFileSync(
			file,
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime\n'
		);

		try {
			const result = await parsePush(
				[
					'https://cache.example.workers.dev/t/acme',
					'--reference-paths-file',
					file,
					'--reference-source',
					'https://cache.example.workers.dev/t/acme/reuse/reuse',
					'--dry-run'
				],
				interrupted
			);

			// The run reached its first remote call, so positional parsing accepted
			// the reference paths as a publication in their own right.
			expect(result).toBeInstanceOf(CliAbortError);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rejects a publication with no paths of any kind', async () => {
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'--dry-run'
		]);

		expect(result).toBeInstanceOf(EmptyPublicationError);
	});

	it('accepts an empty named-root replacement past publication validation', async () => {
		const result = await parsePush(
			['https://cache.example.workers.dev/t/acme', '--root', 'main'],
			interrupted
		);

		// The run reached its first remote call, so a root replacement with no
		// paths is not an empty publication.
		expect(result).toBeInstanceOf(CliAbortError);
	});

	it('rejects --no-retain combined with --root before authenticating', async () => {
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--no-retain',
			'--root',
			'main'
		]);

		expect(result).toBeInstanceOf(NoRetainConflictError);
	});

	it('rejects a mutating GitHub OIDC push naming neither --root nor --no-retain', async () => {
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--github-oidc'
		]);

		expect(result).toBeInstanceOf(OidcRetentionChoiceRequiredError);
	});

	it('rejects a --store URI that names no ssh-ng destination', async () => {
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--store',
			'daemon'
		]);

		expect(result).toBeInstanceOf(InvalidStoreUriError);

		if (!(result instanceof InvalidStoreUriError)) {
			return;
		}

		expect(result.value).toBe('daemon');
	});

	it('parses an ssh-ng --store URI and still validates retention first', async () => {
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--store',
			'ssh-ng://build@example.test',
			'--no-retain',
			'--root',
			'main'
		]);

		expect(result).toBeInstanceOf(NoRetainConflictError);
	});

	it('rejects --run-root-ttl without --run-root before authenticating', async () => {
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			'--run-root-ttl',
			'1h'
		]);

		expect(result).toBeInstanceOf(RunRootTtlWithoutRunRootError);
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
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			...extraArguments
		]);

		expect(result).toBeInstanceOf(ReferenceSourcePairError);
	});

	it.each([
		['--read-user', 'reader'],
		['--read-password', 'secret']
	])('rejects an unpaired %s before authenticating', async (option, value) => {
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			option,
			value
		]);

		expect(result).toBeInstanceOf(ReadCredentialPairError);
	});

	it('rejects a reference paths file naming a non-store path', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const file = path.join(directory, 'references.txt');
		writeFileSync(
			file,
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime\n./result\n'
		);

		try {
			const result = await parsePush([
				'https://cache.example.workers.dev/t/acme',
				'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				'--reference-paths-file',
				file,
				'--reference-source',
				'https://cache.example.workers.dev/t/acme/reuse/reuse'
			]);

			expect(result).toBeInstanceOf(InvalidStorePathError);

			if (!(result instanceof InvalidStorePathError)) {
				return;
			}

			expect(result.storePath).toBe('./result');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rejects a symlink argument that resolves outside the store', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const target = path.join(directory, 'out');
		const link = path.join(directory, 'result');
		writeFileSync(target, 'artefact');
		symlinkSync(target, link);

		try {
			const result = await parsePush([
				'https://cache.example.workers.dev/t/acme',
				link
			]);

			expect(result).toBeInstanceOf(InvalidStorePathError);

			if (!(result instanceof InvalidStorePathError)) {
				return;
			}

			expect(result.storePath).toBe(realpathSync(target));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('resolves symlinks named by a path file before validation', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const target = path.join(directory, 'out');
		const link = path.join(directory, 'intermediate');
		const file = path.join(directory, 'intermediates.txt');
		writeFileSync(target, 'artefact');
		symlinkSync(target, link);
		writeFileSync(file, `${link}\n`);

		try {
			const result = await parsePush([
				'https://cache.example.workers.dev/t/acme',
				'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				'--intermediate-paths-file',
				file
			]);

			expect(result).toBeInstanceOf(InvalidStorePathError);

			if (!(result instanceof InvalidStorePathError)) {
				return;
			}

			expect(result.storePath).toBe(realpathSync(target));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rejects a target that is not a store path before authenticating', async () => {
		const result = await parsePush([
			'https://cache.example.workers.dev/t/acme',
			'./result'
		]);

		expect(result).toBeInstanceOf(InvalidStorePathError);

		if (!(result instanceof InvalidStorePathError)) {
			return;
		}

		expect(result.storePath).toBe('./result');
	});

	it('rejects an intermediate paths file naming a non-store path', async () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-push-'));
		const file = path.join(directory, 'intermediates.txt');
		writeFileSync(
			file,
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime\nnot-a-path\n'
		);

		try {
			const result = await parsePush([
				'https://cache.example.workers.dev/t/acme',
				'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				'--closure',
				'--intermediate-paths-file',
				file
			]);

			expect(result).toBeInstanceOf(InvalidStorePathError);

			if (!(result instanceof InvalidStorePathError)) {
				return;
			}

			expect(result.storePath).toBe('not-a-path');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
