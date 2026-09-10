import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import {
	type PushSummary,
	type PushSummaryInput,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import {
	BooleanInputInvalidError,
	CupboardReleaseSelectionConflictError,
	CupboardVersionOutputMissingError,
	GraceWaitConflictError,
	LegacyPushSummaryError,
	MissingInputError,
	PushPathsMissingError,
	PushSummaryMissingError,
	PushSummaryResponseError,
	ReferenceSourcePairingError,
	RootGroupsJsonInvalidError,
	RootGroupsPathsConflictError,
	RootGroupsRetentionConflictError,
	RootGroupsRootConflictError,
	RootGroupsSchemaError,
	RootRetentionConflictError,
	RunRootRequiredError,
	TtlRetentionConflictError,
	UrlInputInvalidError
} from '../errors.ts';

import {
	acquirePushCupboard,
	aggregatePushSummaries,
	buildPushArguments,
	hasUngracedPath,
	inspectCupboardVersion,
	pathsMissingGraceDeadline,
	publishPushAcquisitionOutputs,
	pushArgumentsForInvocations,
	type PushInputs,
	type PushInvocation,
	type PushOptions,
	requireGraceResultProtocol,
	requirePushSummary,
	resolvePushInputs,
	runPushCupboard
} from './push.ts';

const noExtras = {
	store: '',
	intermediatePathsFile: '',
	referencePathsFile: '',
	referenceSource: '',
	runRoot: '',
	runRootTtl: ''
};

describe('buildPushArguments', () => {
	it('builds a GitHub OIDC push invocation', () => {
		expect(
			buildPushArguments({
				url: new URL('https://cache.example.test'),
				paths: ['/nix/store/a', '/nix/store/b'],
				audience: '',
				root: 'github:owner/repo/main',
				cache: { kind: 'named', name: cacheNameSchema.parse('ci') },
				ttl: '7d',
				retain: true,
				wait: true,
				waitTimeout: '10m',
				attestations: ['/tmp/a.json', '/tmp/b.json'],
				...noExtras
			})
		).toStrictEqual([
			'--no-colour',
			'push',
			'https://cache.example.test/cache/ci',
			'/nix/store/a',
			'/nix/store/b',
			'--github-oidc',
			'--root',
			'github:owner/repo/main',
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

	it('includes the remote store in the push invocation', () => {
		expect(
			buildPushArguments({
				url: new URL('https://cache.example.test'),
				paths: ['/nix/store/a'],
				audience: '',
				root: 'github:owner/repo/main',
				cache: { kind: 'default' },
				ttl: '',
				retain: true,
				wait: true,
				waitTimeout: '',
				attestations: [],
				...noExtras,
				store: 'ssh-ng://build@example.test'
			})
		).toStrictEqual([
			'--no-colour',
			'push',
			'https://cache.example.test',
			'/nix/store/a',
			'--github-oidc',
			'--root',
			'github:owner/repo/main',
			'--store',
			'ssh-ng://build@example.test'
		]);
	});

	it('includes the intermediate, reference and run-root options', () => {
		expect(
			buildPushArguments({
				url: new URL('https://cache.example.test'),
				paths: ['/nix/store/a'],
				audience: '',
				root: 'github:owner/repo/main',
				cache: { kind: 'default' },
				store: '',
				ttl: '',
				retain: true,
				wait: true,
				waitTimeout: '',
				attestations: [],
				intermediatePathsFile: '/tmp/intermediates.txt',
				referencePathsFile: '/tmp/references.txt',
				referenceSource: 'https://cache.example.test/t/acme/reuse/reuse',
				runRoot: 'github:owner/repo/_cupboard-run/12345/app',
				runRootTtl: '24h'
			})
		).toStrictEqual([
			'--no-colour',
			'push',
			'https://cache.example.test',
			'/nix/store/a',
			'--github-oidc',
			'--root',
			'github:owner/repo/main',
			'--intermediate-paths-file',
			'/tmp/intermediates.txt',
			'--reference-paths-file',
			'/tmp/references.txt',
			'--reference-source',
			'https://cache.example.test/t/acme/reuse/reuse',
			'--run-root',
			'github:owner/repo/_cupboard-run/12345/app',
			'--run-root-ttl',
			'24h'
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
		cupboardPath: '',
		version: 'latest',
		includePrereleases: true,
		githubToken: '',
		releaseRepository: 'owner/cupboard',
		expectedSourceCommit: '',
		installDirectory: '/runner/temp/cupboard-bin',
		url: new URL(url),
		paths: [storePath],
		cache: { kind: 'default' },
		store: '',
		audience: '',
		root: 'github:owner/repo/main',
		ttl: '',
		retain: true,
		wait: true,
		waitTimeout: '10m',
		attestations: [],
		requireGrace: false,
		intermediatePathsFile: '',
		referencePathsFile: '',
		referenceSource: '',
		runRoot: '',
		runRootTtl: '',
		rootGroups: []
	};

	it('applies defaults when optional flags are absent', () => {
		expect(resolvePushInputs(baseOptions, environment)).toStrictEqual(defaults);
	});

	it('returns the configured remote store URI unchanged', () => {
		const resolved = resolvePushInputs(
			{ ...baseOptions, store: 'ssh-ng://build@example.test' },
			environment
		);

		expect(resolved.store).toBe('ssh-ng://build@example.test');
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
			UrlInputInvalidError
		],
		[
			'url has a fragment',
			{ ...baseOptions, url: 'https://cupboard.example/t/acme#copied' },
			UrlInputInvalidError
		],
		['paths is empty', { ...baseOptions, paths: [] }, PushPathsMissingError],
		[
			'include-prereleases is not true or false',
			{ ...baseOptions, includePrereleases: 'yes' },
			BooleanInputInvalidError
		],
		[
			'wait is not true or false',
			{ ...baseOptions, wait: 'flase' },
			BooleanInputInvalidError
		],
		[
			'cupboard-path is combined with a release selector',
			{
				...baseOptions,
				cupboardPath: '/opt/cupboard',
				cupboardVersion: 'v1.2.3'
			},
			CupboardReleaseSelectionConflictError
		]
	])('rejects when %s', (_name, options, error) => {
		expect(() => resolvePushInputs(options, environment)).toThrow(error);
	});
});

describe('acquirePushCupboard', () => {
	const reporter = createGithubReporter();
	const inputs = {
		cupboardPath: '/nix/store/cupboard/bin/cupboard',
		installDirectory: '/runner/temp/cupboard-bin',
		releaseRepository: 'owner/cupboard',
		version: 'latest',
		includePrereleases: true,
		githubToken: 'token',
		expectedSourceCommit: ''
	};

	it('uses and inspects a pre-acquired executable without installing', async () => {
		const install = vi.fn();
		const controller = new AbortController();
		const inspectVersion = vi.fn((binaryPath: string) =>
			Promise.resolve(`cupboard source (${binaryPath})`)
		);

		await expect(
			acquirePushCupboard(
				inputs,
				{},
				reporter,
				{ install, inspectVersion },
				controller.signal
			)
		).resolves.toStrictEqual({
			binaryPath: '/nix/store/cupboard/bin/cupboard',
			version: 'cupboard source (/nix/store/cupboard/bin/cupboard)'
		});
		expect({
			installCalls: install.mock.calls,
			inspectVersionCalls: inspectVersion.mock.calls
		}).toStrictEqual({
			installCalls: [],
			inspectVersionCalls: [
				['/nix/store/cupboard/bin/cupboard', controller.signal]
			]
		});
	});

	it('uses the release installer when no executable path is supplied', async () => {
		const installDirectory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-push-install-')
		);
		const installed = {
			binaryPath: '/runner/temp/cupboard-bin/cupboard',
			version: 'v1.2.3',
			sourceCommit: 'a'.repeat(40)
		};
		const install = vi.fn(() => Promise.resolve(installed));
		const inspectVersion = vi.fn();

		await expect(
			acquirePushCupboard(
				{ ...inputs, cupboardPath: '', installDirectory },
				{},
				reporter,
				{ install, inspectVersion }
			)
		).resolves.toStrictEqual(installed);
		expect(inspectVersion).not.toHaveBeenCalled();
	});

	it('rejects a supplied executable with an empty version response', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-version-empty-')
		);
		const binaryPath = path.join(directory, 'cupboard');

		await writeFile(binaryPath, '#!/bin/sh\nexit 0\n');
		await chmod(binaryPath, 0o755);

		await expect(inspectCupboardVersion(binaryPath)).rejects.toBeInstanceOf(
			CupboardVersionOutputMissingError
		);
	});
});

describe('push acquisition compatibility outputs', () => {
	it.each([
		['installed release', '/runner/temp/cupboard', 'v1.2.3'],
		[
			'pre-acquired source binary',
			'/nix/store/cupboard/bin/cupboard',
			'1a01598'
		]
	])(
		'publishes the path and version for %s',
		async (_name, binaryPath, version) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-push-output-')
			);
			const outputFile = path.join(directory, 'github-output');

			await publishPushAcquisitionOutputs(
				{ GITHUB_OUTPUT: outputFile },
				{ binaryPath, version }
			);

			expect(await readFile(outputFile, 'utf8')).toBe(
				`cupboard-path=${binaryPath}\ncupboard-version=${version}\n`
			);
		}
	);
});

describe('buildPushArguments unretained', () => {
	it('appends --no-retain and omits root and ttl when unretained', () => {
		expect(
			buildPushArguments({
				url: new URL('https://cache.example.test'),
				paths: ['/nix/store/a'],
				audience: '',
				root: '',
				cache: { kind: 'default' },
				ttl: '',
				retain: false,
				wait: true,
				waitTimeout: '',
				attestations: [],
				...noExtras
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

	it.each([
		[
			'root is combined with no-retain',
			{ ...baseOptions, retain: 'false', root: 'github:owner/repo/main' },
			RootRetentionConflictError
		],
		[
			'ttl is combined with no-retain',
			{ ...baseOptions, retain: 'false', ttl: '7d' },
			TtlRetentionConflictError
		],
		[
			'require-grace is combined with wait false',
			{ ...baseOptions, requireGrace: 'true', wait: 'false' },
			GraceWaitConflictError
		]
	])('rejects when %s', (_name, options, errorType) => {
		expect(() => resolvePushInputs(options, environment)).toThrow(errorType);
	});
});

describe('resolvePushInputs reference and run-root pairing', () => {
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

	it.each([
		[
			'reference-paths-file is given without reference-source',
			{ ...baseOptions, referencePathsFile: '/tmp/references.txt' },
			ReferenceSourcePairingError
		],
		[
			'reference-source is given without reference-paths-file',
			{
				...baseOptions,
				referenceSource: 'https://cache.example.test/t/acme/reuse/reuse'
			},
			ReferenceSourcePairingError
		],
		[
			'run-root-ttl is given without run-root',
			{ ...baseOptions, runRootTtl: '24h' },
			RunRootRequiredError
		]
	])('rejects when %s', (_name, options, errorType) => {
		expect(() => resolvePushInputs(options, environment)).toThrow(errorType);
	});

	it('resolves reference and run-root inputs given together', () => {
		const inputs = resolvePushInputs(
			{
				...baseOptions,
				referencePathsFile: '/tmp/references.txt',
				referenceSource: 'https://cache.example.test/t/acme/reuse/reuse',
				runRoot: 'github:owner/repo/_cupboard-run/12345/app',
				runRootTtl: '24h'
			},
			environment
		);

		expect({
			referencePathsFile: inputs.referencePathsFile,
			referenceSource: inputs.referenceSource,
			runRoot: inputs.runRoot,
			runRootTtl: inputs.runRootTtl
		}).toStrictEqual({
			referencePathsFile: '/tmp/references.txt',
			referenceSource: 'https://cache.example.test/t/acme/reuse/reuse',
			runRoot: 'github:owner/repo/_cupboard-run/12345/app',
			runRootTtl: '24h'
		});
	});
});

describe('resolvePushInputs root-groups', () => {
	const environment = {
		GITHUB_REPOSITORY: 'owner/repo',
		GITHUB_REF_NAME: 'main',
		GITHUB_ACTION_REPOSITORY: 'owner/cupboard',
		RUNNER_TEMP: '/runner/temp'
	};
	const groups = [
		{ root: 'github:owner/repo/main/app', paths: ['/nix/store/a'] },
		{ root: 'github:owner/repo/main/lib', paths: ['/nix/store/b'] }
	];
	const baseOptions: PushOptions = {
		url: 'https://cupboard.example/t/acme',
		paths: [],
		attestations: [],
		rootGroups: JSON.stringify(groups)
	};

	it('parses root-groups into resolved groups and leaves paths empty', () => {
		const inputs = resolvePushInputs(baseOptions, environment);

		expect({
			rootGroups: inputs.rootGroups,
			paths: inputs.paths
		}).toStrictEqual({ rootGroups: groups, paths: [] });
	});

	it.each([
		[
			'root-groups is combined with paths',
			{ ...baseOptions, paths: ['/nix/store/a'] },
			RootGroupsPathsConflictError
		],
		[
			'root-groups is combined with root',
			{ ...baseOptions, root: 'github:owner/repo/main' },
			RootGroupsRootConflictError
		],
		[
			'root-groups is combined with no-retain',
			{ ...baseOptions, retain: 'false' },
			RootGroupsRetentionConflictError
		],
		[
			'root-groups is not valid JSON',
			{ ...baseOptions, rootGroups: '{not json' },
			RootGroupsJsonInvalidError
		],
		[
			'root-groups does not match {root, paths}[]',
			{ ...baseOptions, rootGroups: JSON.stringify([{ root: 'x' }]) },
			RootGroupsSchemaError
		]
	])('rejects when %s', (_name, options, errorType) => {
		expect(() => resolvePushInputs(options, environment)).toThrow(errorType);
	});
});

describe('pushArgumentsForInvocations', () => {
	const baseInputs: Pick<
		PushInputs,
		| 'url'
		| 'audience'
		| 'cache'
		| 'store'
		| 'ttl'
		| 'retain'
		| 'wait'
		| 'waitTimeout'
		| 'attestations'
		| 'intermediatePathsFile'
		| 'referencePathsFile'
		| 'referenceSource'
		| 'runRoot'
		| 'runRootTtl'
	> = {
		url: new URL('https://cache.example.test'),
		audience: '',
		cache: { kind: 'default' },
		store: '',
		ttl: '',
		retain: true,
		wait: true,
		waitTimeout: '',
		attestations: [],
		intermediatePathsFile: '/tmp/intermediates.txt',
		referencePathsFile: '/tmp/references.txt',
		referenceSource: 'https://cache.example.test/t/acme/reuse/reuse',
		runRoot: 'github:owner/repo/_cupboard-run/12345/app',
		runRootTtl: '24h'
	};

	it('builds a single push when there is one invocation', () => {
		const pushes: readonly PushInvocation[] = [
			{ root: 'github:owner/repo/main', paths: ['/nix/store/a'] }
		];

		expect(pushArgumentsForInvocations(baseInputs, pushes)).toStrictEqual([
			[
				'--no-colour',
				'push',
				'https://cache.example.test',
				'/nix/store/a',
				'--github-oidc',
				'--root',
				'github:owner/repo/main',
				'--intermediate-paths-file',
				'/tmp/intermediates.txt',
				'--reference-paths-file',
				'/tmp/references.txt',
				'--reference-source',
				'https://cache.example.test/t/acme/reuse/reuse',
				'--run-root',
				'github:owner/repo/_cupboard-run/12345/app',
				'--run-root-ttl',
				'24h'
			]
		]);
	});

	it('passes intermediate and reference paths only to the first root push', () => {
		const pushes: readonly PushInvocation[] = [
			{ root: 'github:owner/repo/main/app', paths: ['/nix/store/a'] },
			{ root: 'github:owner/repo/main/lib', paths: ['/nix/store/b'] }
		];

		expect(pushArgumentsForInvocations(baseInputs, pushes)).toStrictEqual([
			[
				'--no-colour',
				'push',
				'https://cache.example.test',
				'/nix/store/a',
				'--github-oidc',
				'--root',
				'github:owner/repo/main/app',
				'--intermediate-paths-file',
				'/tmp/intermediates.txt',
				'--reference-paths-file',
				'/tmp/references.txt',
				'--reference-source',
				'https://cache.example.test/t/acme/reuse/reuse',
				'--run-root',
				'github:owner/repo/_cupboard-run/12345/app',
				'--run-root-ttl',
				'24h'
			],
			[
				'--no-colour',
				'push',
				'https://cache.example.test',
				'/nix/store/b',
				'--github-oidc',
				'--root',
				'github:owner/repo/main/lib',
				'--run-root',
				'github:owner/repo/_cupboard-run/12345/app',
				'--run-root-ttl',
				'24h'
			]
		]);
	});
});

describe('aggregatePushSummaries', () => {
	it('sums counts and concatenates paths and failures across pushes', () => {
		const first = pushSummarySchema.parse({
			uploadedPaths: 1,
			reusedBlobs: 2,
			skipped: 0,
			uploadedBytes: 100,
			failures: [],
			paths: [
				{
					storePathHash: '0'.repeat(32),
					storePath: `/nix/store/${'0'.repeat(32)}-app`,
					outcome: 'committed'
				}
			]
		});
		const second = pushSummarySchema.parse({
			uploadedPaths: 3,
			reusedBlobs: 0,
			skipped: 1,
			uploadedBytes: 50,
			failures: [
				{
					storePathHash: '1'.repeat(32),
					storePath: `/nix/store/${'1'.repeat(32)}-lib`,
					stage: 'upload',
					reason: 'timeout'
				}
			],
			paths: [
				{
					storePathHash: '2'.repeat(32),
					storePath: `/nix/store/${'2'.repeat(32)}-lib`,
					outcome: 'committed'
				}
			]
		});

		expect(aggregatePushSummaries([first, second])).toStrictEqual({
			uploadedPaths: 4,
			reusedBlobs: 2,
			skipped: 1,
			uploadedBytes: 150,
			failures: second.failures,
			paths: [...first.paths, ...second.paths]
		});
	});

	it('returns zeroed counts and empty lists for no pushes', () => {
		expect(aggregatePushSummaries([])).toStrictEqual({
			uploadedPaths: 0,
			reusedBlobs: 0,
			skipped: 0,
			uploadedBytes: 0,
			failures: [],
			paths: []
		});
	});
});

function summaryWithPaths(paths: PushSummaryInput['paths']): PushSummary {
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

	it('passes when every path has a materialised deadline', () => {
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

	// A path with no grace fact indicates that the cache has no configured grace.
	// Exclude it from the per-path deadline failures and detect it with
	// `hasUngracedPath`.
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

	it('reports a path with graceSeconds but no deadline as pending', () => {
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

	it('returns the parsed data from a push-summary result event', () => {
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

	it('throws a schema error for malformed push-summary data', () => {
		expect(() => {
			requirePushSummary([
				{ kind: 'push-summary', data: { uploadedPaths: 'many' } }
			]);
		}).toThrow(PushSummaryResponseError);
	});

	it('reports the recorded result kinds when no push summary exists', () => {
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

	it('forwards the detected protocol to the cupboard invocation', async () => {
		const result = { protocol: 'legacy-stderr' as const, results: [] };
		const controller = new AbortController();
		const detectResultProtocol = vi.fn(() =>
			Promise.resolve('legacy-stderr' as const)
		);
		const run = vi.fn(() => Promise.resolve(result));

		await expect(
			runPushCupboard(
				{
					binaryPath: '/tmp/cupboard',
					arguments: ['push'],
					environment: { RUNNER_TEMP: '/tmp' },
					requireGrace: false,
					version: 'v0.0.13',
					signal: controller.signal
				},
				{
					detectResultProtocol,
					run
				}
			)
		).resolves.toStrictEqual(result);

		expect({
			detectResultProtocol: detectResultProtocol.mock.calls,
			run: run.mock.calls
		}).toStrictEqual({
			detectResultProtocol: [['/tmp/cupboard', controller.signal]],
			run: [
				[
					'/tmp/cupboard',
					['push'],
					{ RUNNER_TEMP: '/tmp' },
					'legacy-stderr',
					{ signal: controller.signal }
				]
			]
		});
	});
});
