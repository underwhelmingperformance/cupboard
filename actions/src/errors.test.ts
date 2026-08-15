import { genericExitCode, usageExitCode } from '@cupboard/shared/errors';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	AttestationNotFoundError,
	AttestationSourceMismatchError,
	AttestationVerificationFailedError,
	CacheInfoFetchError,
	CacheInfoInvalidError,
	CachePublicKeyEmptyResponseError,
	CachePublicKeyRequestFailedError,
	ChecksumMismatchError,
	CommandFailedError,
	CommandOutputTooLargeError,
	CupboardReportedError,
	CupboardResolutionJsonError,
	DerivationGraphShapeError,
	DerivationNodeMissingError,
	DerivationRootCountError,
	DuplicateGroupKeyError,
	GithubApiError,
	GracePolicyMissingError,
	InvalidChecksumLineError,
	InvalidInputError,
	InvalidReleaseAssetUrlError,
	LegacyPushSummaryError,
	MalformedReleaseDiscoveryResponseError,
	MalformedReleaseResponseError,
	MissingChecksumError,
	MissingInputError,
	NoReleaseFoundError,
	ProbeTimeoutError,
	PublishPlanInvariantError,
	PublishTargetsJsonError,
	PublishTargetsSchemaError,
	PushSummaryMissingError,
	ReleaseAssetNotFoundError,
	ReleaseAttestationSearchTooLargeError,
	ReleaseDiscoverySearchTooLargeError,
	ReuseViewPriorityError,
	RootEnsureCommandError,
	RootEnsureResultInvalidError,
	RootEnsureResultMissingError,
	TargetEvaluationError,
	TargetEvaluationResponseError,
	TargetRootUnresolvedError,
	UnsupportedPlatformError
} from './errors.ts';

describe('action errors', () => {
	it.each([
		['MissingInputError', new MissingInputError('cache-url'), usageExitCode],
		[
			'InvalidInputError',
			new InvalidInputError('version', 'bad'),
			usageExitCode
		],
		[
			'UnsupportedPlatformError',
			new UnsupportedPlatformError('sunos', 'sparc'),
			usageExitCode
		],
		['GithubApiError', new GithubApiError('boom'), genericExitCode],
		[
			'MalformedReleaseResponseError',
			new MalformedReleaseResponseError(),
			genericExitCode
		],
		[
			'MalformedReleaseDiscoveryResponseError',
			new MalformedReleaseDiscoveryResponseError(),
			genericExitCode
		],
		[
			'ReleaseDiscoverySearchTooLargeError',
			new ReleaseDiscoverySearchTooLargeError(100, 1000, 20, 101, 101, 1),
			genericExitCode
		],
		[
			'CupboardResolutionJsonError',
			new CupboardResolutionJsonError(new SyntaxError('bad JSON')),
			usageExitCode
		],
		[
			'NoReleaseFoundError',
			new NoReleaseFoundError('owner/repo'),
			genericExitCode
		],
		[
			'ReleaseAssetNotFoundError',
			new ReleaseAssetNotFoundError('v1.2.3', 'cupboard.tar.gz'),
			genericExitCode
		],
		[
			'InvalidReleaseAssetUrlError',
			new InvalidReleaseAssetUrlError(
				'cupboard.tar.gz',
				'https://api.github.com'
			),
			genericExitCode
		],
		[
			'ReleaseAttestationSearchTooLargeError',
			new ReleaseAttestationSearchTooLargeError(100, 10, 101, 1),
			genericExitCode
		],
		[
			'InvalidChecksumLineError',
			new InvalidChecksumLineError('garbage'),
			genericExitCode
		],
		[
			'MissingChecksumError',
			new MissingChecksumError('cupboard.tar.gz'),
			genericExitCode
		],
		[
			'ChecksumMismatchError',
			new ChecksumMismatchError('cupboard.tar.gz', 'aa', 'bb'),
			genericExitCode
		],
		[
			'AttestationNotFoundError',
			new AttestationNotFoundError('cupboard.tar.gz'),
			genericExitCode
		],
		[
			'AttestationVerificationFailedError',
			new AttestationVerificationFailedError('cupboard.tar.gz', 2),
			genericExitCode
		],
		[
			'AttestationSourceMismatchError',
			new AttestationSourceMismatchError('v1.0.0', 'a'.repeat(40), undefined),
			genericExitCode
		],
		[
			'CachePublicKeyRequestFailedError',
			new CachePublicKeyRequestFailedError(
				'https://cache.example.test/pubkey',
				500
			),
			genericExitCode
		],
		[
			'CachePublicKeyEmptyResponseError',
			new CachePublicKeyEmptyResponseError('https://cache.example.test/pubkey'),
			genericExitCode
		],
		[
			'PublishTargetsJsonError',
			new PublishTargetsJsonError(new SyntaxError('bad JSON')),
			usageExitCode
		],
		[
			'PublishTargetsSchemaError',
			new PublishTargetsSchemaError(new z.ZodError([])),
			usageExitCode
		],
		[
			'TargetEvaluationError',
			new TargetEvaluationError('.#app', { cause: new Error('failed') }),
			genericExitCode
		],
		[
			'TargetEvaluationResponseError',
			new TargetEvaluationResponseError('.#app', new SyntaxError('bad JSON')),
			genericExitCode
		],
		[
			'TargetRootUnresolvedError',
			new TargetRootUnresolvedError('.#app'),
			genericExitCode
		],
		[
			'DerivationGraphShapeError',
			new DerivationGraphShapeError('.#app', { cause: new z.ZodError([]) }),
			genericExitCode
		],
		[
			'DerivationRootCountError',
			new DerivationRootCountError('.#app', 2),
			genericExitCode
		],
		[
			'DerivationNodeMissingError',
			new DerivationNodeMissingError('.#app', '/nix/store/app.drv'),
			genericExitCode
		],
		[
			'DuplicateGroupKeyError',
			new DuplicateGroupKeyError('seed-a'),
			genericExitCode
		],
		[
			'GracePolicyMissingError',
			new GracePolicyMissingError(''),
			genericExitCode
		],
		[
			'RootEnsureCommandError',
			new RootEnsureCommandError('main', { cause: new Error('failed') }),
			genericExitCode
		],
		[
			'RootEnsureResultMissingError',
			new RootEnsureResultMissingError('main'),
			genericExitCode
		],
		[
			'RootEnsureResultInvalidError',
			new RootEnsureResultInvalidError('main', { cause: new Error('bad') }),
			genericExitCode
		],
		[
			'PublishPlanInvariantError',
			new PublishPlanInvariantError('index 0'),
			genericExitCode
		],
		[
			'CacheInfoFetchError',
			new CacheInfoFetchError('destination', 'https://cache.example.test', 503),
			genericExitCode
		],
		[
			'CacheInfoInvalidError',
			new CacheInfoInvalidError('view', 'https://cache.example.test', {
				cause: new Error('boom')
			}),
			genericExitCode
		],
		[
			'ReuseViewPriorityError',
			new ReuseViewPriorityError(40, 40),
			usageExitCode
		],
		[
			'ProbeTimeoutError',
			new ProbeTimeoutError('https://cache.example.test/x.narinfo'),
			genericExitCode
		],
		[
			'CommandOutputTooLargeError',
			new CommandOutputTooLargeError('nix build', 16, 17),
			genericExitCode
		],
		[
			'CommandFailedError',
			new CommandFailedError('cupboard', 1),
			genericExitCode
		],
		['CupboardReportedError', new CupboardReportedError(2, []), 2],
		[
			'PushSummaryMissingError',
			new PushSummaryMissingError(['push-plan']),
			genericExitCode
		],
		[
			'LegacyPushSummaryError',
			new LegacyPushSummaryError('v0.0.13'),
			genericExitCode
		]
	])('%s reports its name and exit code', (name, error, exitCode) => {
		expect({ name: error.name, exitCode: error.exitCode }).toStrictEqual({
			name,
			exitCode
		});
	});
});

describe('CupboardReportedError', () => {
	it('carries the status and recorded results', () => {
		const results = [{ kind: 'push-summary', data: { uploadedPaths: 0 } }];
		const error = new CupboardReportedError(2, results);

		expect({
			status: error.status,
			exitCode: error.exitCode,
			results: error.results
		}).toStrictEqual({ status: 2, exitCode: 2, results });
	});
});

describe('PushSummaryMissingError', () => {
	it('records the kinds the run reported instead of a summary', () => {
		const error = new PushSummaryMissingError(['push-plan', 'info']);

		expect(error.kinds).toStrictEqual(['push-plan', 'info']);
	});
});

describe('GithubApiError', () => {
	it('defaults status and cause to undefined', () => {
		const error = new GithubApiError('failed to download cupboard.tar.gz');

		expect({ status: error.status, cause: error.cause }).toStrictEqual({
			status: undefined,
			cause: undefined
		});
	});

	it('carries the status and cause the caller supplies', () => {
		const cause = new Error('root cause');
		const error = new GithubApiError('failed to fetch attestations', {
			status: 404,
			cause
		});

		expect(error.status).toBe(404);
		expect(error.cause).toBe(cause);
	});
});

describe('InvalidChecksumLineError', () => {
	it('carries the offending line', () => {
		expect(new InvalidChecksumLineError('garbage').line).toBe('garbage');
	});
});

describe('MissingChecksumError', () => {
	it('carries the asset name', () => {
		expect(new MissingChecksumError('cupboard.tar.gz').assetName).toBe(
			'cupboard.tar.gz'
		);
	});
});

describe('ChecksumMismatchError', () => {
	it('carries the asset name and both digests', () => {
		const error = new ChecksumMismatchError('cupboard.tar.gz', 'aa', 'bb');

		expect({
			assetName: error.assetName,
			expected: error.expected,
			actual: error.actual
		}).toStrictEqual({
			assetName: 'cupboard.tar.gz',
			expected: 'aa',
			actual: 'bb'
		});
	});
});

describe('AttestationNotFoundError', () => {
	it('carries the archive name', () => {
		expect(new AttestationNotFoundError('cupboard.tar.gz').archiveName).toBe(
			'cupboard.tar.gz'
		);
	});
});

describe('InvalidReleaseAssetUrlError', () => {
	it('carries the asset and expected API origin without echoing the unsafe URL', () => {
		const error = new InvalidReleaseAssetUrlError(
			'cupboard.tar.gz',
			'https://api.github.com'
		);

		expect({
			assetName: error.assetName,
			expectedOrigin: error.expectedOrigin,
			message: error.message
		}).toStrictEqual({
			assetName: 'cupboard.tar.gz',
			expectedOrigin: 'https://api.github.com',
			message:
				'release asset cupboard.tar.gz does not have a credential-safe HTTPS URL on https://api.github.com'
		});
	});
});

describe('ReleaseAttestationSearchTooLargeError', () => {
	it('carries both policy limits and observed totals', () => {
		const error = new ReleaseAttestationSearchTooLargeError(100, 10, 101, 1);

		expect({
			maximumCandidates: error.maximumCandidates,
			maximumPages: error.maximumPages,
			observedCandidates: error.observedCandidates,
			observedPages: error.observedPages
		}).toStrictEqual({
			maximumCandidates: 100,
			maximumPages: 10,
			observedCandidates: 101,
			observedPages: 1
		});
	});
});

describe('ReleaseDiscoverySearchTooLargeError', () => {
	it('carries every release discovery policy limit and observed total', () => {
		const error = new ReleaseDiscoverySearchTooLargeError(
			100,
			1000,
			20,
			1,
			1001,
			11
		);

		expect(error).toMatchObject({
			maximumPageEntries: 100,
			maximumCandidates: 1000,
			maximumPages: 20,
			observedPageEntries: 1,
			observedCandidates: 1001,
			observedPages: 11,
			message:
				'release discovery exceeded its limits: page 11 contained 1 entries and brought the total to 1001; maximum 100 entries per page, 1000 candidates and 20 pages'
		});
	});
});

describe('AttestationVerificationFailedError', () => {
	it('defaults cause to undefined', () => {
		const error = new AttestationVerificationFailedError('cupboard.tar.gz', 2);

		expect({
			archiveName: error.archiveName,
			attempts: error.attempts,
			cause: error.cause
		}).toStrictEqual({
			archiveName: 'cupboard.tar.gz',
			attempts: 2,
			cause: undefined
		});
	});

	it('carries the last bundle failure as its cause', () => {
		const cause = new Error('untrusted signer');
		const error = new AttestationVerificationFailedError('cupboard.tar.gz', 2, {
			cause
		});

		expect(error.cause).toBe(cause);
	});
});

describe('AttestationSourceMismatchError', () => {
	it('carries the tag, tag commit and resolved source commit', () => {
		const error = new AttestationSourceMismatchError(
			'v1.0.0',
			'a'.repeat(40),
			'b'.repeat(40)
		);

		expect({
			tagName: error.tagName,
			tagCommit: error.tagCommit,
			sourceCommit: error.sourceCommit
		}).toStrictEqual({
			tagName: 'v1.0.0',
			tagCommit: 'a'.repeat(40),
			sourceCommit: 'b'.repeat(40)
		});
	});

	it('allows an unresolved source commit', () => {
		const error = new AttestationSourceMismatchError(
			'v1.0.0',
			'a'.repeat(40),
			undefined
		);

		expect(error.sourceCommit).toBeUndefined();
	});
});

describe('CachePublicKeyRequestFailedError', () => {
	it('carries the url and status', () => {
		const error = new CachePublicKeyRequestFailedError(
			'https://cache.example.test/pubkey',
			500
		);

		expect({ url: error.url, status: error.status }).toStrictEqual({
			url: 'https://cache.example.test/pubkey',
			status: 500
		});
	});
});

describe('CachePublicKeyEmptyResponseError', () => {
	it('carries the url', () => {
		expect(
			new CachePublicKeyEmptyResponseError('https://cache.example.test/pubkey')
				.url
		).toBe('https://cache.example.test/pubkey');
	});
});

describe('MalformedReleaseResponseError', () => {
	it('defaults cause to undefined', () => {
		expect(new MalformedReleaseResponseError().cause).toBeUndefined();
	});

	it('carries the cause a failed schema parse supplies', () => {
		const cause = new Error('invalid shape');
		const error = new MalformedReleaseResponseError({ cause });

		expect(error.cause).toBe(cause);
	});
});

describe('CommandFailedError', () => {
	it('defaults cause to undefined', () => {
		expect(new CommandFailedError('cupboard', 1).cause).toBeUndefined();
	});

	it('carries the cause a spawn failure supplies', () => {
		const cause = new Error('spawn cupboard ENOENT');
		const error = new CommandFailedError('cupboard', 1, cause.message, {
			cause
		});

		expect(error.cause).toBe(cause);
	});
});

describe('TargetEvaluationError', () => {
	it('carries the attribute and the evaluator failure as its cause', () => {
		const cause = new Error('cannot fetch the private input');
		const error = new TargetEvaluationError('.#app', { cause });

		expect({ attribute: error.attribute, cause: error.cause }).toStrictEqual({
			attribute: '.#app',
			cause
		});
	});
});

describe('TargetRootUnresolvedError', () => {
	it('carries the target attribute', () => {
		expect(new TargetRootUnresolvedError('.#app').attribute).toBe('.#app');
	});
});

describe('DerivationGraphShapeError', () => {
	it('carries the attribute and the parse failure as its cause', () => {
		const cause = new z.ZodError([]);
		const error = new DerivationGraphShapeError('.#app', { cause });

		expect({ attribute: error.attribute, cause: error.cause }).toStrictEqual({
			attribute: '.#app',
			cause
		});
	});
});

describe('DerivationRootCountError', () => {
	it('carries the attribute and the root count', () => {
		const error = new DerivationRootCountError('.#app', 2);

		expect({ attribute: error.attribute, count: error.count }).toStrictEqual({
			attribute: '.#app',
			count: 2
		});
	});
});

describe('DerivationNodeMissingError', () => {
	it('carries the attribute and the missing derivation path', () => {
		const error = new DerivationNodeMissingError('.#app', '/nix/store/app.drv');

		expect({
			attribute: error.attribute,
			drvPath: error.drvPath
		}).toStrictEqual({ attribute: '.#app', drvPath: '/nix/store/app.drv' });
	});
});

describe('DuplicateGroupKeyError', () => {
	it('carries the colliding key', () => {
		expect(new DuplicateGroupKeyError('seed-a').key).toBe('seed-a');
	});
});

describe('PublishPlanInvariantError', () => {
	it('carries the missing subject', () => {
		expect(new PublishPlanInvariantError('index 0').subject).toBe('index 0');
	});
});

describe('CacheInfoInvalidError', () => {
	it('carries the causal error by reference', () => {
		const cause = new Error('root cause');

		expect(
			new CacheInfoInvalidError('view', 'https://cache.example.test', { cause })
				.cause
		).toBe(cause);
	});
});

describe('RootEnsureCommandError', () => {
	it('carries the root and the runner failure as its cause', () => {
		const cause = new Error('spawn cupboard ENOENT');
		const error = new RootEnsureCommandError('main', { cause });

		expect({ root: error.root, cause: error.cause }).toStrictEqual({
			root: 'main',
			cause
		});
	});
});

describe('RootEnsureResultMissingError', () => {
	it('carries the root', () => {
		expect(new RootEnsureResultMissingError('main').root).toBe('main');
	});
});

describe('RootEnsureResultInvalidError', () => {
	it('carries the root and the parse failure as its cause', () => {
		const cause = new Error('malformed result line');
		const error = new RootEnsureResultInvalidError('main', { cause });

		expect({ root: error.root, cause: error.cause }).toStrictEqual({
			root: 'main',
			cause
		});
	});
});
