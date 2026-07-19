import { genericExitCode, usageExitCode } from '@cupboard/shared/errors';
import { describe, expect, it } from 'vitest';

import {
	AttestationNotFoundError,
	AttestationSourceMismatchError,
	AttestationVerificationFailedError,
	CachePublicKeyEmptyResponseError,
	CachePublicKeyRequestFailedError,
	ChecksumMismatchError,
	CommandFailedError,
	CupboardReportedError,
	GithubApiError,
	InvalidChecksumLineError,
	InvalidInputError,
	MalformedReleaseResponseError,
	MissingChecksumError,
	MissingInputError,
	NoReleaseFoundError,
	PushSummaryMissingError,
	ReleaseAssetNotFoundError,
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
			'CommandFailedError',
			new CommandFailedError('cupboard', 1),
			genericExitCode
		],
		['CupboardReportedError', new CupboardReportedError(2, []), 2],
		[
			'PushSummaryMissingError',
			new PushSummaryMissingError(['push-plan']),
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

	it('carries the status and cause a site supplies', () => {
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
