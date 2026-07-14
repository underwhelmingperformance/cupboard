import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError
} from '../errors.ts';

import { registerPushCommand, validateRetentionChoice } from './push.ts';

describe('validateRetentionChoice', () => {
	it.each([
		{
			name: '--no-retain combined with --root',
			options: { retain: false, root: 'main' },
			error: NoRetainConflictError
		},
		{
			name: '--no-retain combined with --ttl',
			options: { retain: false, ttl: 1_209_600 },
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
		{ name: 'a named root', options: { root: 'main' } },
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
