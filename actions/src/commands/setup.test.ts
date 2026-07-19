import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.ts';

import { setupAction, setupInputs, writeNetrc } from './setup.ts';

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

describe('action input errors', () => {
	it.each([
		['read-user is supplied without read-password', { READ_USER: 'ci' }],
		[
			'read-password is supplied without read-user',
			{ READ_PASSWORD: 'secret' }
		],
		['cache-url is not an http(s) URL', { CACHE_URL: 'not a url' }]
	])('rejects when %s', async (_name, environment) => {
		await expect(setupAction(environment)).rejects.toThrow(InvalidInputError);
	});
});

describe('setupInputs', () => {
	const baseEnvironment = {
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

	it('applies defaults when optional inputs are absent', () => {
		expect(setupInputs(baseEnvironment)).toStrictEqual(defaults);
	});

	it('treats blank inputs as unset and applies the defaults', () => {
		const blanked = {
			...baseEnvironment,
			INPUT_CUPBOARD_VERSION: '  ',
			INPUT_INSTALL_DIR: '',
			INPUT_INCLUDE_PRERELEASES: '',
			INPUT_ADD_TO_PATH: ' '
		};

		expect(setupInputs(blanked)).toStrictEqual(defaults);
	});

	it('does not require RUNNER_TEMP when install-dir is explicit', () => {
		const inputs = setupInputs({
			GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
			INPUT_INSTALL_DIR: '/opt/cupboard'
		});

		expect(inputs.installDirectory).toBe('/opt/cupboard');
	});
});
