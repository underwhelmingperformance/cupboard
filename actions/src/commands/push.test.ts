import {
	type ParsedPushSummary,
	type PushSummary,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import { rootSetMaxTargets } from '@cupboard/protocol/retention';
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
	hasUngracedPath,
	pathsMissingGraceDeadline,
	type PushOptions,
	requireGraceResultProtocol,
	requirePushSummary,
	resolvePushInputs,
	resolvePushPublication,
	runPushCupboard,
	validateRetainedPathLimit
} from './push.ts';

describe('buildPushArguments', () => {
	it('builds a GitHub OIDC push invocation', () => {
		expect(
			buildPushArguments({
				url: 'https://cache.example.test',
				paths: ['/nix/store/a', '/nix/store/b'],
				additionalPathsFile: '/tmp/publication-paths',
				closure: true,
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
			'--additional-paths-file',
			'/tmp/publication-paths',
			'--closure',
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
		additionalPathsFile: '',
		closure: false,
		cache: '',
		audience: '',
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
		[
			'url is not an http(s) URL',
			{ ...baseOptions, url: 'cupboard.example/t/acme' },
			InvalidInputError
		],
		[
			'url carries a fragment',
			{ ...baseOptions, url: 'https://cupboard.example/t/acme#copied' },
			InvalidInputError
		],
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

	it('does not reproduce a rejected URL in its diagnostic', () => {
		const secret = 'read-token';
		let failure: unknown;

		try {
			resolvePushInputs(
				{ ...baseOptions, url: `https://cupboard.example/t/acme#${secret}` },
				environment
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toStrictEqual(
			new InvalidInputError(
				'url',
				'url must be an http(s) URL with nothing beyond origin and path'
			)
		);
		expect((failure as Error).message).not.toContain(secret);
	});
});

describe('buildPushArguments unretained', () => {
	it('appends --no-retain and omits root and ttl when unretained', () => {
		expect(
			buildPushArguments({
				url: 'https://cache.example.test',
				paths: ['/nix/store/a'],
				additionalPathsFile: '',
				closure: false,
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

	it('accepts an additional-only unretained publication', () => {
		const inputs = resolvePushInputs(
			{
				...baseOptions,
				paths: [],
				additionalPathsFile: '/tmp/publication-paths',
				retain: 'false'
			},
			environment
		);

		expect({
			paths: inputs.paths,
			additionalPathsFile: inputs.additionalPathsFile,
			retain: inputs.retain
		}).toStrictEqual({
			paths: [],
			additionalPathsFile: '/tmp/publication-paths',
			retain: false
		});
	});

	it('accepts an additional-only retained publication', () => {
		const inputs = resolvePushInputs(
			{
				...baseOptions,
				paths: [],
				additionalPathsFile: '/tmp/publication-paths'
			},
			environment
		);

		expect({
			paths: inputs.paths,
			additionalPathsFile: inputs.additionalPathsFile,
			retain: inputs.retain,
			root: inputs.root
		}).toStrictEqual({
			paths: [],
			additionalPathsFile: '/tmp/publication-paths',
			retain: true,
			root: 'github:owner/repo/main'
		});
	});

	it('rejects an empty primary path set without an additional paths file', () => {
		expect(() =>
			resolvePushInputs(
				{ ...baseOptions, paths: [], retain: 'false' },
				environment
			)
		).toThrow(InvalidInputError);
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

describe('resolvePushPublication', () => {
	const first = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-first';
	const second = '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-second';

	it('keeps retained and additional paths separate for a current CLI', () => {
		expect(
			resolvePushPublication(
				{
					paths: [first],
					publicationPaths: [first, second],
					additionalPathsFile: '/tmp/publication-paths',
					closure: false,
					retain: true
				},
				{ additionalPathsFile: true, closure: true }
			)
		).toStrictEqual({
			paths: [first],
			additionalPathsFile: '/tmp/publication-paths',
			closure: false,
			hasPositionalAdditionalPathsFallback: false,
			implicitClosureFallback: false
		});
	});

	it('promotes every retained partial output to a target root', () => {
		expect(
			resolvePushPublication(
				{
					paths: [],
					publicationPaths: [first, second],
					additionalPathsFile: '/tmp/publication-paths',
					closure: false,
					retain: true
				},
				{ additionalPathsFile: true, closure: true }
			)
		).toStrictEqual({
			paths: [first, second],
			additionalPathsFile: '',
			closure: false,
			hasPositionalAdditionalPathsFallback: false,
			implicitClosureFallback: false
		});
	});

	it('uses an anchor and the publication file for unretained partial output', () => {
		expect(
			resolvePushPublication(
				{
					paths: [],
					publicationPaths: [first, second],
					additionalPathsFile: '/tmp/publication-paths',
					closure: true,
					retain: false
				},
				{ additionalPathsFile: true, closure: true }
			)
		).toStrictEqual({
			paths: [first],
			additionalPathsFile: '/tmp/publication-paths',
			closure: true,
			hasPositionalAdditionalPathsFallback: false,
			implicitClosureFallback: false
		});
	});

	it('falls back to positional publication paths for an older retained CLI', () => {
		expect(
			resolvePushPublication(
				{
					paths: [first],
					publicationPaths: [first, second],
					additionalPathsFile: '/tmp/publication-paths',
					closure: false,
					retain: true
				},
				{ additionalPathsFile: false, closure: false }
			)
		).toStrictEqual({
			paths: [first, second],
			additionalPathsFile: '',
			closure: false,
			hasPositionalAdditionalPathsFallback: true,
			implicitClosureFallback: true
		});
	});

	it('falls back to positional publication paths for an older unretained CLI', () => {
		expect(
			resolvePushPublication(
				{
					paths: [first],
					publicationPaths: [first, second],
					additionalPathsFile: '/tmp/publication-paths',
					closure: false,
					retain: false
				},
				{ additionalPathsFile: false, closure: false }
			)
		).toStrictEqual({
			paths: [first, second],
			additionalPathsFile: '',
			closure: false,
			hasPositionalAdditionalPathsFallback: true,
			implicitClosureFallback: true
		});
	});

	it('omits the unsupported closure flag when legacy closure matches the request', () => {
		expect(
			resolvePushPublication(
				{
					paths: [first],
					publicationPaths: [],
					additionalPathsFile: '',
					closure: true,
					retain: true
				},
				{ additionalPathsFile: false, closure: false }
			)
		).toStrictEqual({
			paths: [first],
			additionalPathsFile: '',
			closure: false,
			hasPositionalAdditionalPathsFallback: false,
			implicitClosureFallback: false
		});
	});

	it('rejects an empty publication file when no primary path succeeded', () => {
		expect(() =>
			resolvePushPublication(
				{
					paths: [],
					publicationPaths: [],
					additionalPathsFile: '/tmp/publication-paths',
					closure: false,
					retain: true
				},
				{ additionalPathsFile: true, closure: true }
			)
		).toThrow(InvalidInputError);
	});
});

describe('validateRetainedPathLimit', () => {
	const paths = Array.from(
		{ length: rootSetMaxTargets + 1 },
		(_, index) => `/nix/store/path-${String(index)}`
	);

	it.each([
		['accepts the root target limit', paths.slice(0, rootSetMaxTargets), true],
		['accepts an unretained publication above the limit', paths, false]
	])('%s', (_name, values, retain) => {
		expect(() => {
			validateRetainedPathLimit(values, retain);
		}).not.toThrow();
	});

	it('rejects a retained publication above the root target limit', () => {
		expect(() => {
			validateRetainedPathLimit(paths, true);
		}).toThrow(InvalidInputError);
	});

	it('counts each retained store path once', () => {
		expect(() => {
			validateRetainedPathLimit(
				Array.from(
					{ length: rootSetMaxTargets + 1 },
					() => '/nix/store/duplicate'
				),
				true
			);
		}).not.toThrow();
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

	// A fact-less path is a cache-level condition, so the per-path report
	// leaves it out and `hasUngracedPath` carries it instead.
	it('reports a path whose grace fact is empty as ungraced, not per-path', () => {
		const summary = summaryWithPaths([
			{ storePathHash: storePathHashB, outcome: 'committed', grace: {} }
		]);

		expect({
			ungraced: hasUngracedPath(summary),
			missing: pathsMissingGraceDeadline(summary)
		}).toStrictEqual({ ungraced: true, missing: [] });
	});

	it('reports a fully graced summary as not ungraced', () => {
		expect(
			hasUngracedPath(
				summaryWithPaths([
					{
						storePathHash: storePathHashB,
						outcome: 'committed',
						grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
					}
				])
			)
		).toBe(false);
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

	it('reuses a protocol detected with the push capabilities', async () => {
		const result = { protocol: 'result-file' as const, results: [] };
		const detectResultProtocol = vi.fn();
		const run = vi.fn(() => Promise.resolve(result));

		await expect(
			runPushCupboard(
				{
					binaryPath: '/tmp/cupboard',
					arguments: ['push'],
					environment: { RUNNER_TEMP: '/tmp' },
					requireGrace: false,
					version: 'v0.0.14',
					protocol: 'result-file'
				},
				{ detectResultProtocol, run }
			)
		).resolves.toStrictEqual(result);

		expect(detectResultProtocol).not.toHaveBeenCalled();
	});
});
