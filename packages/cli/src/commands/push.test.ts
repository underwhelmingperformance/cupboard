import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import { rootNameSchema, ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError,
	ReferenceSourcePairError,
	RunRootTtlWithoutRunRootError
} from '../errors.ts';

import {
	parsePathFile,
	pushCommandAuthorizationDetails,
	registerPushCommand,
	validateRetentionChoice
} from './push.ts';

const rootName = (value: string) => rootNameSchema.parse(value);

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

function silentProgram(): Command {
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
	registerPushCommand(program);

	return program;
}

async function parsePush(arguments_: readonly string[]): Promise<unknown> {
	try {
		await silentProgram().parseAsync(['push', ...arguments_], {
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
