import { describe, expect, it } from 'vitest';

import { InvalidInputError, MissingInputError } from '../errors.ts';

import {
	buildPushArguments,
	type PushOptions,
	resolvePushInputs
} from './push.ts';

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

const url = 'https://cupboard.example/t/acme';
const storePath = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo';

const baseOptions: PushOptions = {
	url,
	paths: [storePath],
	attestations: []
};

describe('resolvePushInputs', () => {
	const environment = {
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

	it('applies defaults when optional flags are absent', () => {
		expect(resolvePushInputs(baseOptions, environment)).toStrictEqual(defaults);
	});

	it('treats blank flag values as unset and applies the defaults', () => {
		const blanked: PushOptions = {
			...baseOptions,
			audience: '',
			root: ' ',
			waitTimeout: '  '
		};

		expect(resolvePushInputs(blanked, environment)).toStrictEqual(defaults);
	});

	it('does not require git refs when root is explicit', () => {
		const inputs = resolvePushInputs(
			{ ...baseOptions, root: 'github:explicit/root' },
			{
				GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
				RUNNER_TEMP: '/runner/temp'
			}
		);

		expect(inputs.root).toBe('github:explicit/root');
	});

	it('resolves boolean flag values', () => {
		const resolved = resolvePushInputs(
			{ ...baseOptions, includePrereleases: 'false', wait: 'false' },
			environment
		);

		expect({
			includePrereleases: resolved.includePrereleases,
			wait: resolved.wait
		}).toStrictEqual({ includePrereleases: false, wait: false });
	});

	it.each([
		['url is missing', { ...baseOptions, url: undefined }, MissingInputError],
		['url is blank', { ...baseOptions, url: '  ' }, MissingInputError],
		['paths is empty', { ...baseOptions, paths: [] }, InvalidInputError],
		[
			'include-prereleases is not true or false',
			{ ...baseOptions, includePrereleases: 'yes' },
			InvalidInputError
		],
		[
			'wait is not true or false',
			{ ...baseOptions, wait: 'flase' },
			InvalidInputError
		]
	])('rejects when %s', (_name, options, error) => {
		expect(() => resolvePushInputs(options, environment)).toThrow(error);
	});
});
