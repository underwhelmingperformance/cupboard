import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	InvalidUploadConcurrencyError,
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError,
	RunRootTtlWithoutRunRootError
} from '../errors.ts';

import { registerBuildPushCommand } from './build-push.ts';

const tenantUrl = 'https://cupboard.example.workers.dev/t/acme';

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
	registerBuildPushCommand(program);

	return program;
}

async function parseBuildPush(arguments_: readonly string[]): Promise<unknown> {
	try {
		await silentProgram().parseAsync(['build-push', ...arguments_], {
			from: 'user'
		});

		return { kind: 'parsed' as const };
	} catch (error: unknown) {
		return error;
	}
}

describe('registerBuildPushCommand', () => {
	it.each([
		{
			name: '--no-retain combined with --root',
			arguments_: [
				tenantUrl,
				'--no-retain',
				'--root',
				'main',
				'--',
				'nix',
				'build'
			],
			error: NoRetainConflictError
		},
		{
			name: '--no-retain combined with --ttl',
			arguments_: [
				tenantUrl,
				'--no-retain',
				'--ttl',
				'7d',
				'--',
				'nix',
				'build'
			],
			error: NoRetainConflictError
		},
		{
			name: '--run-root-ttl without --run-root',
			arguments_: [
				tenantUrl,
				'--root',
				'main',
				'--run-root-ttl',
				'1h',
				'--',
				'nix',
				'build'
			],
			error: RunRootTtlWithoutRunRootError
		},
		{
			name: 'a GitHub OIDC run naming neither --root nor --no-retain',
			arguments_: [tenantUrl, '--github-oidc', '--', 'nix', 'build'],
			error: OidcRetentionChoiceRequiredError
		},
		{
			name: 'a non-numeric --upload-concurrency',
			arguments_: [
				tenantUrl,
				'--upload-concurrency',
				'zero',
				'--',
				'nix',
				'build'
			],
			error: InvalidUploadConcurrencyError
		},
		{
			name: 'a missing build command',
			arguments_: [tenantUrl],
			error: CommanderError
		}
	])('rejects $name', async ({ arguments_, error }) => {
		const result = await parseBuildPush(arguments_);

		expect(result).toBeInstanceOf(error);
	});
});
