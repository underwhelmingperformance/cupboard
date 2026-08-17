import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface CommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

class InvalidSettingsDocumentError extends Error {
	constructor() {
		super('nix config show --json did not return an object');
		this.name = 'InvalidSettingsDocumentError';
	}
}

class OracleProbeCommandError extends Error {
	constructor(
		public readonly operation: string,
		public readonly stderr: string
	) {
		super(`${operation} failed:\n${stderr}`);
		this.name = 'OracleProbeCommandError';
	}
}

class InvalidOracleProbeArgumentsError extends Error {
	constructor() {
		super('usage: conformance-oracle-probe <nix> <system>');
		this.name = 'InvalidOracleProbeArgumentsError';
	}
}

class OracleProbeSystemMismatchError extends Error {
	constructor(
		public readonly expected: string,
		public readonly reported: string
	) {
		super(`the ${expected} probe ran with a ${reported} Nix binary`);
		this.name = 'OracleProbeSystemMismatchError';
	}
}

const integerWidthProbes = {
	negative: '-1',
	unsignedThirtyTwo: '4294967295',
	signedSixtyFour: '9223372036854775807',
	unsignedSixtyFour: '18446744073709551615'
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function run(
	binary: string,
	arguments_: readonly string[],
	environment: NodeJS.ProcessEnv
): CommandResult {
	const result = spawnSync(binary, arguments_, {
		env: environment,
		encoding: 'utf8'
	});

	if (result.error !== undefined) {
		throw result.error;
	}

	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr
	};
}

function requireSuccess(result: CommandResult, operation: string): string {
	if (result.status !== 0) {
		throw new OracleProbeCommandError(operation, result.stderr.trim());
	}

	return result.stdout.trim();
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
	const configDirectory = path.join(home, 'nix-conf');
	mkdirSync(configDirectory, { recursive: true });
	writeFileSync(path.join(configDirectory, 'nix.conf'), '');

	return {
		HOME: home,
		NIX_CONF_DIR: configDirectory,
		NIX_USER_CONF_FILES: '/dev/null',
		PATH: process.env.PATH ?? ''
	};
}

function main(): void {
	const [binary, expectedSystem] = process.argv.slice(2);

	if (binary === undefined || expectedSystem === undefined) {
		throw new InvalidOracleProbeArgumentsError();
	}

	const home = mkdtempSync(path.join(tmpdir(), 'cupboard-oracle-probe-'));
	const environment = isolatedEnvironment(home);
	const system = requireSuccess(
		run(
			binary,
			[
				'--extra-experimental-features',
				'nix-command',
				'eval',
				'--raw',
				'--impure',
				'--expr',
				'builtins.currentSystem'
			],
			environment
		),
		'reading the Nix system'
	);

	if (system !== expectedSystem) {
		throw new OracleProbeSystemMismatchError(expectedSystem, system);
	}

	const version = requireSuccess(
		run(binary, ['--version'], environment),
		'reading the Nix version'
	);
	const settingsDocument = requireSuccess(
		run(
			binary,
			[
				'--extra-experimental-features',
				'nix-command',
				'config',
				'show',
				'--json'
			],
			environment
		),
		'reading the Nix settings'
	);
	const settings: unknown = JSON.parse(settingsDocument);

	if (!isRecord(settings)) {
		throw new InvalidSettingsDocumentError();
	}

	const acceptedWidthProbes: Record<string, Record<string, boolean>> = {};

	for (const [name, setting] of Object.entries(settings)) {
		if (!isRecord(setting) || typeof setting.value !== 'number') {
			continue;
		}

		acceptedWidthProbes[name] = Object.fromEntries(
			Object.entries(integerWidthProbes).map(([probe, value]) => {
				const result = run(
					binary,
					[
						'--extra-experimental-features',
						'nix-command',
						'config',
						'show',
						name
					],
					{ ...environment, NIX_CONFIG: `${name} = ${value}` }
				);

				return [probe, result.status === 0];
			})
		);
	}

	process.stdout.write(
		`${JSON.stringify({ system, version, settings, acceptedWidthProbes })}\n`
	);
}

main();
