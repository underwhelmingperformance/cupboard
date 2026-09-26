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
const user = {
	url: 'https://user-cache.example',
	key: 'user-cache-1:ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8='
};

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

interface Scenario {
	readonly module: 'nixos' | 'home-manager';
	readonly file: PrivateFile;
	readonly user: 'none' | 'settings' | 'extraOptions';
}

interface ModuleCase extends Scenario {
	readonly name: string;
	readonly expected: NixSettings;
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
 * Reads the settings that Nix derives from the system `nix.conf` in
 * `NIX_CONF_DIR` and the user-level files in `NIX_USER_CONF_FILES`.
 */
async function shownSettings(
	environment: NodeJS.ProcessEnv
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
		{ env: environment }
	);
	const settings = configShowSchema.parse(JSON.parse(shown.stdout));

	return {
		substituters: settings.substituters.value,
		trustedPublicKeys: settings['trusted-public-keys'].value
	};
}

/**
 * Renders the module's `nix.conf` for the scenario and returns the settings
 * that Nix reads, together with the settings of an empty configuration for
 * comparison. The NixOS module's file is the system `nix.conf`. The Home
 * Manager module's file is a user-level `nix.conf`, which Nix reads after a
 * system file that lists the system cache.
 */
async function renderedSettings(
	scenario: Scenario
): Promise<{ readonly rendered: NixSettings; readonly empty: NixSettings }> {
	return withTemporaryDirectory(
		'cupboard-nix-module-',
		async (root) => {
			const environment = await isolatedEnvironment(path.join(root, 'home'));
			const systemDirectory = path.join(root, 'system');
			const emptyDirectory = path.join(root, 'empty');
			await mkdir(systemDirectory);
			await mkdir(emptyDirectory);

			const substitutersFile = await privateFile(root, scenario.file);
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
							module: scenario.module,
							substitutersFile,
							system,
							cupboard,
							user: { ...user, configuration: scenario.user }
						})
					}
				}
			);
			const userFile = path.join(root, 'user-nix.conf');
			const systemFile = path.join(systemDirectory, 'nix.conf');

			if (scenario.module === 'nixos') {
				await writeFile(systemFile, rendered.stdout);
			} else {
				await writeFile(
					systemFile,
					`substituters = ${system.url}\ntrusted-public-keys = ${system.key}\n`
				);
				await writeFile(userFile, rendered.stdout);
			}

			return {
				rendered: await shownSettings({
					...environment,
					NIX_CONF_DIR: systemDirectory,
					...(scenario.module === 'home-manager' && {
						NIX_USER_CONF_FILES: userFile
					})
				}),
				empty: await shownSettings({
					...environment,
					NIX_CONF_DIR: emptyDirectory
				})
			};
		},
		{ makeWritableBeforeCleanup: true }
	);
}

describe.skipIf(!isNixPresent)('the cupboard Nix module', () => {
	it.each<ModuleCase>([
		{
			name: 'NixOS, private file present',
			module: 'nixos',
			file: 'present',
			user: 'none',
			expected: {
				substituters: [system.url, cupboard.url, privateUrl],
				trustedPublicKeys: [system.key, cupboard.key, cupboard.privateKey]
			}
		},
		{
			name: 'NixOS, private file absent',
			module: 'nixos',
			file: 'absent',
			user: 'none',
			expected: {
				substituters: [system.url, cupboard.url],
				trustedPublicKeys: [system.key, cupboard.key, cupboard.privateKey]
			}
		},
		{
			name: 'Home Manager, system cache in the system nix.conf',
			module: 'home-manager',
			file: 'present',
			user: 'none',
			expected: {
				substituters: [system.url, cupboard.url, privateUrl],
				trustedPublicKeys: [system.key, cupboard.key, cupboard.privateKey]
			}
		},
		{
			name: 'Home Manager, private file absent',
			module: 'home-manager',
			file: 'absent',
			user: 'none',
			expected: {
				substituters: [system.url, cupboard.url],
				trustedPublicKeys: [system.key, cupboard.key, cupboard.privateKey]
			}
		},
		{
			name: "Home Manager, user's own bare substituters and keys",
			module: 'home-manager',
			file: 'present',
			user: 'settings',
			expected: {
				substituters: [user.url, cupboard.url, privateUrl],
				trustedPublicKeys: [user.key, cupboard.key, cupboard.privateKey]
			}
		},
		{
			name: "Home Manager, bare substituters and keys in the user's extraOptions",
			module: 'home-manager',
			file: 'present',
			user: 'extraOptions',
			expected: {
				substituters: [user.url, cupboard.url, privateUrl],
				trustedPublicKeys: [user.key, cupboard.key, cupboard.privateKey]
			}
		}
	])('adds its caches and keys: $name', async ({ expected, ...scenario }) => {
		const { rendered } = await renderedSettings(scenario);

		expect(rendered).toStrictEqual(expected);
	});

	// Nix checks whether the included file exists, and that check fails when
	// the account cannot search the directory. Nix then ignores the whole system
	// `nix.conf` for that account without an error. Root can search every
	// directory, so the case runs only as another account.
	it.skipIf(isRoot)(
		"makes Nix ignore the system nix.conf when the private file's directory is not searchable",
		async () => {
			const { rendered, empty } = await renderedSettings({
				module: 'nixos',
				file: 'unreachable',
				user: 'none'
			});

			expect(rendered).toStrictEqual(empty);
		}
	);
});
