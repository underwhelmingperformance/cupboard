import {
	type ParsedPushSummary,
	type PushSummary,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import { describe, expect, it, vi } from 'vitest';

import {
	InvalidInputError,
	LegacyPushSummaryError,
	MissingInputError,
	PushSummaryMissingError,
	PushSummaryResponseError
} from '../errors.ts';

import {
	buildPushArguments,
	pathsMissingGraceDeadline,
	type PushOptions,
	requireGraceResultProtocol,
	requirePushSummary,
	resolvePushInputs,
	runPushCupboard
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
				retain: true,
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
		expectedSourceCommit: '',
		installDirectory: '/runner/temp/cupboard-bin',
		url,
		paths: [storePath],
		cache: '',
		audience: url,
		root: 'github:owner/repo/main',
		ttl: '',
		retain: true,
		wait: true,
		waitTimeout: '10m',
		attestations: [],
		requireGrace: false
	};

	it('applies defaults when optional flags are absent', () => {
		expect(resolvePushInputs(baseOptions, environment)).toStrictEqual(defaults);
	});

	it('preserves the expected release source commit', () => {
		const resolved = resolvePushInputs(
			{ ...baseOptions, expectedSourceCommit: 'a'.repeat(40) },
			environment
		);

		expect(resolved.expectedSourceCommit).toBe('a'.repeat(40));
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

describe('buildPushArguments unretained', () => {
	it('appends --no-retain and omits root and ttl when unretained', () => {
		expect(
			buildPushArguments({
				url: 'https://cache.example.test',
				paths: ['/nix/store/a'],
				audience: '',
				root: '',
				cache: '',
				ttl: '',
				retain: false,
				wait: true,
				waitTimeout: '',
				attestations: []
			})
		).toStrictEqual([
			'--no-colour',
			'push',
			'https://cache.example.test',
			'/nix/store/a',
			'--github-oidc',
			'--audience',
			'https://cache.example.test',
			'--no-retain'
		]);
	});
});

describe('resolvePushInputs unretained', () => {
	const environment = {
		GITHUB_REPOSITORY: 'owner/repo',
		GITHUB_REF_NAME: 'main',
		GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
		RUNNER_TEMP: '/runner/temp'
	};
	const baseOptions: PushOptions = {
		url: 'https://cupboard.example/t/acme',
		paths: ['/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo'],
		attestations: []
	};

	it('suppresses the implicit default root and ttl when unretained', () => {
		const inputs = resolvePushInputs(
			{ ...baseOptions, retain: 'false' },
			environment
		);

		expect({
			retain: inputs.retain,
			root: inputs.root,
			ttl: inputs.ttl
		}).toStrictEqual({ retain: false, root: '', ttl: '' });
	});

	it.each([
		[
			'root is combined with no-retain',
			{ ...baseOptions, retain: 'false', root: 'github:owner/repo/main' }
		],
		[
			'ttl is combined with no-retain',
			{ ...baseOptions, retain: 'false', ttl: '7d' }
		],
		[
			'require-grace is combined with wait false',
			{ ...baseOptions, requireGrace: 'true', wait: 'false' }
		]
	])('rejects when %s', (_name, options) => {
		expect(() => resolvePushInputs(options, environment)).toThrow(
			InvalidInputError
		);
	});
});

function summaryWithPaths(paths: PushSummary['paths']): ParsedPushSummary {
	return pushSummarySchema.parse({
		uploadedPaths: 0,
		reusedBlobs: 0,
		skipped: 0,
		uploadedBytes: 0,
		failures: [],
		paths
	});
}

describe('pathsMissingGraceDeadline', () => {
	const storePathHashA = '0'.repeat(32);
	const storePathHashB = '1'.repeat(32);
	const storePathHashC = '2'.repeat(32);
	const storePathA = `/nix/store/${storePathHashA}-app`;

	it('passes when every path carries a materialised deadline', () => {
		expect(
			pathsMissingGraceDeadline(
				summaryWithPaths([
					{
						storePathHash: storePathHashA,
						storePath: storePathA,
						outcome: 'already-present',
						grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
					}
				])
			)
		).toStrictEqual([]);
	});

	it('passes for a push of zero new paths', () => {
		expect(pathsMissingGraceDeadline(summaryWithPaths([]))).toStrictEqual([]);
	});

	it('names a path whose grace fact is empty as unmatched', () => {
		expect(
			pathsMissingGraceDeadline(
				summaryWithPaths([
					{ storePathHash: storePathHashB, outcome: 'committed', grace: {} }
				])
			)
		).toStrictEqual([
			{ storePathHash: storePathHashB, reason: 'no-policy-matched' }
		]);
	});

	it('names a path whose grace is only captured so far as pending', () => {
		expect(
			pathsMissingGraceDeadline(
				summaryWithPaths([
					{
						storePathHash: storePathHashC,
						outcome: 'pending',
						grace: { graceSeconds: 900 }
					}
				])
			)
		).toStrictEqual([{ storePathHash: storePathHashC, reason: 'pending' }]);
	});
});

describe('requirePushSummary', () => {
	const storePathHash = '3'.repeat(32);

	it('yields the parsed data for a push-summary result event', () => {
		const data = {
			uploadedPaths: 1,
			reusedBlobs: 0,
			skipped: 0,
			uploadedBytes: 14,
			failures: [],
			paths: [
				{ storePathHash, outcome: 'committed', grace: { graceSeconds: 900 } }
			]
		};

		expect(requirePushSummary([{ kind: 'push-summary', data }])).toStrictEqual(
			pushSummarySchema.parse(data)
		);
	});

	it('adapts the summary emitted by the latest legacy release', () => {
		const data = {
			uploadedPaths: 1,
			reusedBlobs: 0,
			skipped: 0,
			uploadedBytes: 14,
			failures: []
		};

		expect(
			requirePushSummary([{ kind: 'push-summary', data }], 'legacy-stderr')
		).toStrictEqual({ ...data, paths: [] });
	});

	it('raises the schema error for a malformed push-summary data line', () => {
		expect(() => {
			requirePushSummary([
				{ kind: 'push-summary', data: { uploadedPaths: 'many' } }
			]);
		}).toThrow(PushSummaryResponseError);
	});

	it('names the recorded kinds when no push-summary result was captured', () => {
		let failure: unknown;

		try {
			requirePushSummary([{ kind: 'push-plan', data: { wouldUpload: 1 } }]);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(PushSummaryMissingError);

		if (failure instanceof PushSummaryMissingError) {
			expect(failure.kinds).toStrictEqual(['push-plan']);
		}
	});
});

describe('requireGraceResultProtocol', () => {
	it('rejects a legacy release that cannot report per-path grace facts', () => {
		expect(() => {
			requireGraceResultProtocol('legacy-stderr', 'v0.0.13');
		}).toThrow(LegacyPushSummaryError);
	});

	it('accepts the result-file protocol', () => {
		expect(() => {
			requireGraceResultProtocol('result-file', 'v0.0.14');
		}).not.toThrow();
	});
});

describe('runPushCupboard', () => {
	it('rejects legacy grace mode before spawning cupboard push', async () => {
		const run = vi.fn();

		await expect(
			runPushCupboard(
				{
					binaryPath: '/tmp/cupboard',
					arguments: ['push'],
					environment: {},
					requireGrace: true,
					version: 'v0.0.13'
				},
				{
					detectResultProtocol: () => Promise.resolve('legacy-stderr'),
					run
				}
			)
		).rejects.toBeInstanceOf(LegacyPushSummaryError);

		expect(run).not.toHaveBeenCalled();
	});

	it('passes the detected protocol into the cupboard invocation', async () => {
		const result = { protocol: 'legacy-stderr' as const, results: [] };
		const run = vi.fn(() => Promise.resolve(result));

		await expect(
			runPushCupboard(
				{
					binaryPath: '/tmp/cupboard',
					arguments: ['push'],
					environment: { RUNNER_TEMP: '/tmp' },
					requireGrace: false,
					version: 'v0.0.13'
				},
				{
					detectResultProtocol: () => Promise.resolve('legacy-stderr'),
					run
				}
			)
		).resolves.toStrictEqual(result);

		expect(run.mock.calls).toStrictEqual([
			['/tmp/cupboard', ['push'], { RUNNER_TEMP: '/tmp' }, 'legacy-stderr']
		]);
	});
});
