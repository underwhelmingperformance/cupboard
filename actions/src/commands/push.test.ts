import { describe, expect, it } from 'vitest';

import { InvalidInputError, MissingInputError } from '../errors.ts';

import { buildPushArguments, pushInputs } from './push.ts';

describe('buildPushArguments', () => {
	it('builds a GitHub OIDC push invocation', () => {
		expect(
			buildPushArguments({
				url: 'https://cache.example.test',
				paths: ['/nix/store/a', '/nix/store/b'],
				audience: '',
				root: 'github:owner/repo/main',
				cache: 'ci',
				ttl: '7d',
				wait: true,
				waitTimeout: '10m',
				attestations: ['/tmp/a.json', '/tmp/b.json']
			})
		).toStrictEqual([
			'--no-colour',
			'push',
			'https://cache.example.test',
			'/nix/store/a',
			'/nix/store/b',
			'--github-oidc',
			'--audience',
			'https://cache.example.test',
			'--root',
			'github:owner/repo/main',
			'--cache',
			'ci',
			'--ttl',
			'7d',
			'--wait-timeout',
			'10m',
			'--attestation',
			'/tmp/a.json',
			'--attestation',
			'/tmp/b.json'
		]);
	});
});

describe('pushInputs', () => {
	const url = 'https://cupboard.example/t/acme';
	const storePath = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo';

	const baseEnvironment = {
		INPUT_URL: url,
		INPUT_PATHS: storePath,
		GITHUB_REPOSITORY: 'owner/repo',
		GITHUB_REF_NAME: 'main',
		GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
		RUNNER_TEMP: '/runner/temp'
	};

	const defaults = {
		version: 'latest',
		includePrereleases: true,
		githubToken: '',
		releaseRepository: 'owner/cupboard',
		installDirectory: '/runner/temp/cupboard-bin',
		url,
		paths: [storePath],
		cache: '',
		audience: url,
		root: 'github:owner/repo/main',
		ttl: '',
		wait: true,
		waitTimeout: '10m',
		attestations: []
	};

	it('applies defaults when optional inputs are absent', () => {
		expect(pushInputs(baseEnvironment)).toStrictEqual(defaults);
	});

	it('treats blank inputs as unset and applies the defaults', () => {
		const blanked = {
			...baseEnvironment,
			INPUT_AUDIENCE: '',
			INPUT_ROOT: ' ',
			INPUT_WAIT: '',
			INPUT_WAIT_TIMEOUT: '  '
		};

		expect(pushInputs(blanked)).toStrictEqual(defaults);
	});

	it('does not require git refs when root is explicit', () => {
		const inputs = pushInputs({
			INPUT_URL: url,
			INPUT_PATHS: storePath,
			INPUT_ROOT: 'github:explicit/root',
			GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
			RUNNER_TEMP: '/runner/temp'
		});

		expect(inputs.root).toBe('github:explicit/root');
	});

	it.each([
		[
			'url is missing',
			{ INPUT_PATHS: storePath, RUNNER_TEMP: '/runner/temp' },
			MissingInputError
		],
		[
			'paths is empty',
			{ INPUT_URL: url, INPUT_PATHS: '  ', RUNNER_TEMP: '/runner/temp' },
			InvalidInputError
		]
	])('rejects when %s', (_name, environment, error) => {
		expect(() => pushInputs(environment)).toThrow(error);
	});
});
