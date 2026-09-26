import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	temporaryRoot,
	withTemporaryDirectory
} from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';
import { runCommand } from '../support/process.ts';

const isNixPresent =
	spawnSync('nix', ['--version'], { stdio: 'ignore' }).status === 0;
const isRoot = process.getuid?.() === 0;

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

// Every case evaluates the flake's locked nixpkgs with `builtins.fetchTree`.
// Upstream Nix keeps the fetched tarball in its cache directory and downloads
// it again for an empty cache, even when the store path is valid. The cases
// therefore share one cache directory, so the suite downloads nixpkgs at most
// once. Each case still has its own `HOME` for `nix config show`.
const evaluation: { cacheDirectory?: string } = {};

beforeAll(async () => {
	evaluation.cacheDirectory = await mkdtemp(
		path.join(temporaryRoot, 'cupboard-nix-module-cache-')
	);
});

afterAll(async () => {
	if (evaluation.cacheDirectory !== undefined) {
		await rm(evaluation.cacheDirectory, { force: true, recursive: true });
	}
});

const renderExpression = path.join(
	import.meta.dirname,
	'nix-module-render.nix'
);

const system = {
	url: 'https://system-cache.example',
	key: 'system-cache-1:YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8='
};
const cupboard = {
	url: 'https://cupboard.example/t/acme',
	key: 'cupboard-acme-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	privateKey: 'cupboard-acme-2:QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8='
};
const privateUrl = 'https://cupboard.example/t/acme/cache/release';

const listSettingSchema = z.object({ value: z.array(z.string()) });
const configShowSchema = z.object({
	substituters: listSettingSchema,
	'trusted-public-keys': listSettingSchema
});

interface NixSettings {
	readonly substituters: readonly string[];
	readonly trustedPublicKeys: readonly string[];
}

type PrivateFile = 'present' | 'absent' | 'unreachable';

interface ModuleCase {
	readonly file: PrivateFile;
	readonly substituters: readonly string[];
}

/**
 * Writes the private cache's file as the case requires and returns its path.
 * An unreachable file is inside a directory that the test account cannot
 * enter.
 */
async function privateFile(root: string, file: PrivateFile): Promise<string> {
	const directory = path.join(root, 'secrets');
	const substitutersFile = path.join(directory, 'cupboard-release.conf');
	await mkdir(directory);

	if (file !== 'absent') {
		await writeFile(substitutersFile, `extra-substituters = ${privateUrl}\n`);
	}

	if (file === 'unreachable') {
		await chmod(directory, 0o000);
	}

	return substitutersFile;
}

/**
 * Reads the settings that Nix derives from a system `nix.conf`.
 */
async function shownSettings(
	environment: NodeJS.ProcessEnv,
	configDirectory: string
): Promise<NixSettings> {
	const shown = await runCommand(
		'nix',
		[
			'--extra-experimental-features',
			'nix-command',
			'config',
			'show',
			'--json'
		],
		{ env: { ...environment, NIX_CONF_DIR: configDirectory } }
	);
	const settings = configShowSchema.parse(JSON.parse(shown.stdout));

	return {
		substituters: settings.substituters.value,
		trustedPublicKeys: settings['trusted-public-keys'].value
	};
}

/**
 * Renders the NixOS module's `nix.conf` for the case's private file and returns
 * the settings that Nix reads from it, together with the settings of an empty
 * configuration for comparison.
 */
async function renderedSettings(
	file: PrivateFile
): Promise<{ readonly rendered: NixSettings; readonly empty: NixSettings }> {
	return withTemporaryDirectory(
		'cupboard-nix-module-',
		async (root) => {
			const environment = await isolatedEnvironment(path.join(root, 'home'));
			const systemDirectory = path.join(root, 'system');
			const emptyDirectory = path.join(root, 'empty');
			await mkdir(systemDirectory);
			await mkdir(emptyDirectory);

			const substitutersFile = await privateFile(root, file);
			const rendered = await runCommand(
				'nix',
				['eval', '--impure', '--raw', '--file', renderExpression],
				{
					env: {
						...environment,
						...(evaluation.cacheDirectory !== undefined && {
							XDG_CACHE_HOME: evaluation.cacheDirectory
						}),
						CUPBOARD_NIX_MODULE_INPUT: JSON.stringify({
							root: repositoryRoot,
							substitutersFile,
							system,
							cupboard
						})
					}
				}
			);
			await writeFile(path.join(systemDirectory, 'nix.conf'), rendered.stdout);

			return {
				rendered: await shownSettings(environment, systemDirectory),
				empty: await shownSettings(environment, emptyDirectory)
			};
		},
		{ makeWritableBeforeCleanup: true }
	);
}

describe.skipIf(!isNixPresent)('the NixOS module', () => {
	it.each<ModuleCase>([
		{
			file: 'present',
			substituters: [cupboard.url, system.url, privateUrl]
		},
		{
			file: 'absent',
			substituters: [cupboard.url, system.url]
		}
	])(
		'adds its caches and keys when the private file is $file',
		async ({ file, substituters }) => {
			const { rendered } = await renderedSettings(file);

			expect(rendered).toStrictEqual({
				substituters,
				trustedPublicKeys: [system.key, cupboard.key, cupboard.privateKey]
			});
		}
	);

	// Nix checks whether the included file exists, and that check fails when
	// the directory cannot be entered. Nix then ignores the whole system
	// `nix.conf` for that account without an error. Root can enter every
	// directory, so the case runs only as another account.
	it.skipIf(isRoot)(
		"makes Nix ignore the system nix.conf when the private file's directory is not searchable",
		async () => {
			const { rendered, empty } = await renderedSettings('unreachable');

			expect(rendered).toStrictEqual(empty);
		}
	);
});
