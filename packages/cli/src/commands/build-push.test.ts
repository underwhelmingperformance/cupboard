import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	CohortInputError,
	CohortsFileInvalidError,
	InvalidUploadConcurrencyError,
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError,
	RunRootTtlWithoutRunRootError
} from '../errors.ts';

import {
	betweenCohortCollector,
	parseCohortsFile,
	registerBuildPushCommand
} from './build-push.ts';

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
			error: CohortInputError
		},
		{
			name: 'a build command combined with a cohorts file',
			arguments_: [
				tenantUrl,
				'--cohorts-file',
				'cohorts.json',
				'--',
				'nix',
				'build'
			],
			error: CohortInputError
		}
	])('rejects $name', async ({ arguments_, error }) => {
		const result = await parseBuildPush(arguments_);

		expect(result).toBeInstanceOf(error);
	});
});

describe('parseCohortsFile', () => {
	it('parses command and constructed cohorts in order', () => {
		const contents = JSON.stringify({
			cohorts: [
				{ command: ['nix', 'build', '--no-link', '.#app'] },
				{
					installables: ['.#lib'],
					attempts: 2,
					verifyRebuilds: true,
					keepGoing: true,
					maxJobs: 4
				},
				{ installables: ['.#docs'] }
			]
		});

		expect(parseCohortsFile(contents)).toStrictEqual([
			{ kind: 'command', command: ['nix', 'build', '--no-link', '.#app'] },
			{
				kind: 'constructed',
				build: {
					installables: ['.#lib'],
					attempts: 2,
					verifyRebuilds: true,
					keepGoing: true,
					maxJobs: 4
				}
			},
			{ kind: 'constructed', build: { installables: ['.#docs'] } }
		]);
	});

	it('accepts a remote-builders-only cohort with zero local build jobs', () => {
		const contents = JSON.stringify({
			cohorts: [{ installables: ['.#app'], maxJobs: 0 }]
		});

		expect(parseCohortsFile(contents)).toStrictEqual([
			{ kind: 'constructed', build: { installables: ['.#app'], maxJobs: 0 } }
		]);
	});

	it.each([
		{ name: 'a body that is not JSON', contents: 'not json' },
		{ name: 'a body with no cohorts', contents: '{"cohorts": []}' },
		{
			name: 'a cohort with an empty command',
			contents: '{"cohorts": [{"command": []}]}'
		},
		{
			name: 'a cohort naming both forms',
			contents: '{"cohorts": [{"command": ["nix"], "installables": [".#app"]}]}'
		},
		{
			name: 'a cohort with an unknown key',
			contents: '{"cohorts": [{"installables": [".#app"], "surprise": 1}]}'
		}
	])('refuses $name', ({ contents }) => {
		let error: unknown;
		try {
			parseCohortsFile(contents);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(CohortsFileInvalidError);
	});
});

describe('betweenCohortCollector', () => {
	interface CollectorRun {
		readonly commands: readonly (readonly string[])[];
		readonly warnings: readonly { label: string; value?: string }[];
	}

	async function runCollector(exitStatus: number): Promise<CollectorRun> {
		const commands: (readonly string[])[] = [];
		const warnings: { label: string; value?: string }[] = [];
		const collect = betweenCohortCollector(
			{
				warn(label, value) {
					warnings.push({ label, value });
				}
			},
			(options) => {
				commands.push(options.command);

				return Promise.resolve({ status: exitStatus, signal: undefined });
			}
		);

		await collect();

		return { commands, warnings };
	}

	it('sweeps with nix store gc, silently on success', async () => {
		expect(await runCollector(0)).toStrictEqual({
			commands: [['nix', 'store', 'gc']],
			warnings: []
		});
	});

	it('surfaces a failed sweep as a warning and carries on', async () => {
		expect(await runCollector(5)).toStrictEqual({
			commands: [['nix', 'store', 'gc']],
			warnings: [
				{
					label: 'collection failed',
					value:
						'nix store gc exited 5; the next cohort builds with the store as it stands'
				}
			]
		});
	});
});
