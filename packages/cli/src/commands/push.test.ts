import { rootNameSchema, ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError
} from '../errors.ts';

import {
	pushCommandAuthorizationDetails,
	registerPushCommand,
	validateRetentionChoice
} from './push.ts';

const rootName = (value: string) => rootNameSchema.parse(value);

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
		{ name: 'an interactive push naming neither', options: {} }
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
});
