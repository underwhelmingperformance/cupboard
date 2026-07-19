import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.ts';

import { resolveSetupInputs, type SetupOptions, writeNetrc } from './setup.ts';

describe('writeNetrc', () => {
	it('writes a private netrc file scoped to the cache host', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-netrc-'));
		const netrcFile = await writeNetrc({
			cacheUrl: 'https://cache.example.test/t/acme',
			readUser: 'ci',
			readPassword: 'secret',
			runnerTemporaryDirectory: directory
		});
		const stats = await stat(netrcFile);

		expect({
			contents: await readFile(netrcFile, 'utf8'),
			mode: stats.mode & 0o777
		}).toStrictEqual({
			contents: 'machine cache.example.test login ci password secret\n',
			mode: 0o600
		});
	});
});

const baseOptions: SetupOptions = {};

describe('resolveSetupInputs', () => {
	const environment = {
		RUNNER_TEMP: '/runner/temp',
		GITHUB_ACTION_REPOSITORY: 'owner/cupboard'
	};

	const defaults = {
		version: 'latest',
		includePrereleases: true,
		githubToken: '',
		releaseRepository: 'owner/cupboard',
		installDirectory: '/runner/temp/cupboard-bin',
		addToPath: true,
		cacheUrl: '',
		cache: '',
		trustedPublicKey: '',
		readUser: '',
		readPassword: '',
		nixConfigFile: ''
	};

	it('applies defaults when optional flags are absent', () => {
		expect(resolveSetupInputs(baseOptions, environment)).toStrictEqual(
			defaults
		);
	});

	it('treats blank flag values as unset and applies the defaults', () => {
		const blanked: SetupOptions = {
			...baseOptions,
			cupboardVersion: '  ',
			installDir: '',
			cache: ' ',
			nixConfigFile: ''
		};

		expect(resolveSetupInputs(blanked, environment)).toStrictEqual(defaults);
	});

	it('does not require RUNNER_TEMP when install-dir is explicit', () => {
		const inputs = resolveSetupInputs(
			{ ...baseOptions, installDir: '/opt/cupboard' },
			{ GITHUB_ACTION_REPOSITORY: 'owner/cupboard' }
		);

		expect(inputs.installDirectory).toBe('/opt/cupboard');
	});

	it('resolves boolean flag values', () => {
		const resolved = resolveSetupInputs(
			{ ...baseOptions, includePrereleases: 'false', addToPath: 'false' },
			environment
		);

		expect({
			includePrereleases: resolved.includePrereleases,
			addToPath: resolved.addToPath
		}).toStrictEqual({ includePrereleases: false, addToPath: false });
	});

	it.each([
		[
			'read-user is supplied without read-password',
			{ ...baseOptions, readUser: 'ci' }
		],
		[
			'read-password is supplied without read-user',
			{ ...baseOptions, readPassword: 'secret' }
		],
		[
			'cache-url is not an http(s) URL',
			{ ...baseOptions, cacheUrl: 'not a url' }
		],
		[
			'include-prereleases is not true or false',
			{ ...baseOptions, includePrereleases: 'yes' }
		],
		[
			'add-to-path is not true or false',
			{ ...baseOptions, addToPath: 'flase', installDir: '/opt/cupboard' }
		]
	])('rejects when %s', (_name, options) => {
		expect(() => resolveSetupInputs(options, {})).toThrow(InvalidInputError);
	});
});
