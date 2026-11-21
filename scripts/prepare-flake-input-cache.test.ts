import { execFile } from 'node:child_process';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = new URL(
	'../actions/prepare/flake-input-cache.sh',
	import.meta.url
);
const lockHash = 'a'.repeat(64);

const temporaryDirectories: string[] = [];

afterEach(async () => {
	const directories = [...temporaryDirectories];
	temporaryDirectories.length = 0;
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { force: true, recursive: true })
		)
	);
});

interface ScriptRun {
	readonly status: number;
	readonly stdout: string;
	readonly output: string;
	readonly environment: string;
	readonly configuration: string;
	/**
	Whether the copy of the cache that the run started with still exists.
	*/
	readonly keepsEarlierCopy: boolean;
	readonly directory: string;
}

function commandStatus(error: unknown): number {
	return error instanceof Error &&
		'code' in error &&
		typeof error.code === 'number'
		? error.code
		: -1;
}

function commandOutput(error: unknown): string {
	return error instanceof Error &&
		'stdout' in error &&
		typeof error.stdout === 'string'
		? error.stdout
		: '';
}

/**
The `builders` setting that the stub `nix` reports. `inline` reports `value`.
`machines` reports a reference to a machines file, as Nix's default
`@/etc/nix/machines` is, with `padding` between `@` and the path and `suffix`
after the path. The file has `contents`, or
does not exist when `contents` is undefined. `unreadable` reports a reference
to a machines path that is a directory, which cannot be read. With `failing`,
`nix config show builders` exits with an error.
*/
type EffectiveBuilders =
	| { readonly kind: 'inline'; readonly value: string }
	| {
			readonly kind: 'machines';
			readonly contents?: string;
			readonly padding?: string;
			readonly suffix?: string;
	  }
	| { readonly kind: 'unreadable' }
	| { readonly kind: 'failing' };

const noBuilders: EffectiveBuilders = { kind: 'machines' };

// A `nix` that answers only `nix config show builders`, with the value in
// FAKE_BUILDERS, or fails when FAKE_BUILDERS_FAIL is set.
const nixStub = [
	'#!/bin/sh',
	'[ "$1 $2 $3" = "config show builders" ] || exit 64',
	'[ -z "${FAKE_BUILDERS_FAIL:-}" ] || exit 1',
	`printf '%s\\n' "\${FAKE_BUILDERS}"`,
	''
].join('\n');

function fakeBuilders(
	builders: EffectiveBuilders,
	machines: string
): Record<string, string> {
	switch (builders.kind) {
		case 'inline': {
			return { FAKE_BUILDERS: builders.value };
		}
		case 'machines': {
			const { padding = '', suffix = '' } = builders;

			return { FAKE_BUILDERS: `@${padding}${machines}${suffix}` };
		}
		case 'unreadable': {
			return { FAKE_BUILDERS: `@${machines}` };
		}
		case 'failing': {
			return { FAKE_BUILDERS: '', FAKE_BUILDERS_FAIL: '1' };
		}
	}
}

// Runs the script with a home directory that contains a copy of the cache
// from an earlier job, as a persistent runner can.
async function runScript(
	command: 'locate' | 'restored' | 'use',
	variables: Readonly<Record<string, string>>,
	builders: EffectiveBuilders = noBuilders
): Promise<ScriptRun> {
	const root = await mkdtemp(path.join(tmpdir(), 'cupboard-flake-cache-'));
	temporaryDirectories.push(root);
	const home = path.join(root, 'home');
	const directory = path.join(home, '.cache', 'cupboard-flake-inputs');
	const output = path.join(root, 'output');
	const environment = path.join(root, 'environment');
	const configuration = path.join(root, 'cupboard-prepare-nix.conf');
	const bin = path.join(root, 'bin');
	const machines = path.join(root, 'machines');
	await mkdir(directory, { recursive: true });
	await mkdir(bin);
	await Promise.all([
		writeFile(output, ''),
		writeFile(environment, ''),
		writeFile(configuration, ''),
		writeFile(path.join(bin, 'nix'), nixStub, { mode: 0o755 }),
		...(builders.kind === 'machines' && builders.contents !== undefined
			? [writeFile(machines, builders.contents)]
			: []),
		...(builders.kind === 'unreadable' ? [mkdir(machines)] : [])
	]);

	const result = await runBash([script.pathname, command], {
		PATH: `${bin}:${process.env.PATH ?? ''}`,
		HOME: home,
		RUNNER_TEMP: root,
		GITHUB_OUTPUT: output,
		GITHUB_ENV: environment,
		...fakeBuilders(builders, machines),
		...variables
	});

	return {
		...result,
		output: await readFile(output, 'utf8'),
		environment: await readFile(environment, 'utf8'),
		configuration: await readFile(configuration, 'utf8'),
		keepsEarlierCopy: await doesExist(directory),
		directory
	};
}

async function runBash(
	arguments_: readonly string[],
	environment: NodeJS.ProcessEnv
): Promise<{ readonly status: number; readonly stdout: string }> {
	try {
		const { stdout } = await execFileAsync('bash', arguments_, {
			env: environment
		});

		return { status: 0, stdout };
	} catch (error) {
		return { status: commandStatus(error), stdout: commandOutput(error) };
	}
}

async function doesExist(file: string): Promise<boolean> {
	try {
		await access(file);

		return true;
	} catch {
		return false;
	}
}

const notice = (message: string) => `::notice::${message}\n`;

describe('flake input cache preparation', () => {
	it.each([
		{
			name: 'a flake.lock and no remote store',
			variables: { FLAKE_INPUT_CACHE: 'true' },
			isOn: true,
			stdout: ''
		},
		{
			name: 'flake-input-cache set to false',
			variables: { FLAKE_INPUT_CACHE: 'false' },
			isOn: false,
			stdout: notice(
				'The flake input cache is off because flake-input-cache is false.'
			)
		},
		{
			name: 'a remote store, which the plan job still collects for',
			variables: {
				FLAKE_INPUT_CACHE: 'true',
				STORE: 'ssh-ng://nix@store.example.com'
			},
			isOn: true,
			stdout: ''
		},
		{
			name: 'a checkout without flake.lock',
			variables: { FLAKE_INPUT_CACHE: 'true', LOCK_HASH: '' },
			isOn: false,
			stdout: notice(
				'The flake input cache is off because the checkout has no flake.lock.'
			)
		}
	])('locates the cache for $name', async ({ variables, isOn, stdout }) => {
		const run = await runScript('locate', {
			LOCK_HASH: lockHash,
			STORE: '',
			...variables
		});
		const key = `cupboard-flake-inputs-v1-${lockHash}`;

		expect(run).toStrictEqual({
			status: 0,
			stdout,
			output: isOn ? `key=${key}\n` : '',
			environment: isOn
				? `CUPBOARD_FLAKE_INPUT_CACHE_DIRECTORY=${run.directory}\nCUPBOARD_FLAKE_INPUT_CACHE_KEY=${key}\n`
				: '',
			configuration: '',
			keepsEarlierCopy: !isOn,
			directory: run.directory
		});
	});

	it('refuses a value other than true or false', async () => {
		const run = await runScript('locate', {
			FLAKE_INPUT_CACHE: 'yes',
			LOCK_HASH: lockHash,
			STORE: ''
		});

		expect({
			status: run.status,
			output: run.output,
			environment: run.environment
		}).toStrictEqual({ status: 1, output: '', environment: '' });
	});

	it('records that the cache was restored', async () => {
		const run = await runScript('restored', {});

		expect(run).toStrictEqual({
			status: 0,
			stdout: '',
			output: '',
			environment: 'CUPBOARD_FLAKE_INPUT_CACHE_RESTORED=true\n',
			configuration: '',
			keepsEarlierCopy: true,
			directory: run.directory
		});
	});

	const builderLine = 'ssh-ng://nix@builder.example.com x86_64-linux - 4 1';
	const buildersSet = notice(
		"The job does not use the flake input cache because Nix has remote builders. Nix would send the cache's substituter setting to each builder, which cannot read the runner's files."
	);
	const buildersUnknown = notice(
		"The job does not use the flake input cache because it cannot read Nix's builders setting or a machines file, so Nix can have remote builders. Nix would send the cache's substituter setting to each builder, which cannot read the runner's files."
	);

	it.each<{
		name: string;
		store: string;
		builders: EffectiveBuilders;
		stdout: string;
	}>([
		{
			name: 'no builders and no machines file',
			store: '',
			builders: { kind: 'machines' },
			stdout: ''
		},
		{
			name: 'a machines file with only comments',
			store: '',
			builders: { kind: 'machines', contents: '# none\n\n' },
			stdout: ''
		},
		{
			name: 'an empty builders setting',
			store: '',
			builders: { kind: 'inline', value: '' },
			stdout: ''
		},
		{
			name: 'builders from the configuration',
			store: '',
			builders: { kind: 'inline', value: builderLine },
			stdout: buildersSet
		},
		{
			name: 'builders from the machines file',
			store: '',
			builders: { kind: 'machines', contents: `# remote\n${builderLine}\n` },
			stdout: buildersSet
		},
		{
			name: 'a machines file with comments and whitespace around a builder',
			store: '',
			builders: {
				kind: 'machines',
				contents: `  \t\n   # remote\n\t ${builderLine} # fast  \n`
			},
			stdout: buildersSet
		},
		{
			name: 'a machines file with comments after whitespace only',
			store: '',
			builders: { kind: 'machines', contents: '  # one\n\t# two\n \t \n' },
			stdout: ''
		},
		{
			name: 'a machines file reference with a trailing comment',
			store: '',
			builders: {
				kind: 'machines',
				contents: `${builderLine}\n`,
				suffix: ' # default  '
			},
			stdout: buildersSet
		},
		{
			name: 'whitespace between @ and the machines file path',
			store: '',
			builders: {
				kind: 'machines',
				contents: `${builderLine}\n`,
				padding: ' \t',
				suffix: ' '
			},
			stdout: buildersSet
		},
		{
			name: 'a machines file that cannot be read',
			store: '',
			builders: { kind: 'unreadable' },
			stdout: buildersUnknown
		},
		{
			name: 'a builders setting that cannot be read',
			store: '',
			builders: { kind: 'failing' },
			stdout: buildersUnknown
		},
		{
			name: 'a remote store',
			store: 'ssh-ng://nix@store.example.com',
			builders: { kind: 'machines' },
			stdout: notice(
				"The job does not use the flake input cache because store is set. Nix would send the cache's substituter setting to the remote store, which cannot read the runner's files."
			)
		}
	])(
		'uses the restored cache with $name',
		async ({ store, builders, stdout }) => {
			const run = await runScript('use', { STORE: store }, builders);
			const isUsed = stdout === '';

			expect(run).toStrictEqual({
				status: 0,
				stdout,
				output: '',
				environment: '',
				configuration: isUsed
					? `extra-substituters = file://${run.directory}?priority=10\n`
					: '',
				keepsEarlierCopy: true,
				directory: run.directory
			});
		}
	);
});
