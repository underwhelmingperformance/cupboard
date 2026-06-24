import { genericExitCode, usageExitCode } from '@cupboard/shared/errors';
import { describe, expect, it } from 'vitest';

import {
	AttestationError,
	CachePublicKeyError,
	ChecksumError,
	CommandFailedError,
	GithubApiError,
	InvalidInputError,
	MalformedResponseError,
	MissingInputError,
	NixError,
	UnknownCommandError,
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
		['UnknownCommandError', new UnknownCommandError('frob'), usageExitCode],
		['GithubApiError', new GithubApiError('boom'), genericExitCode],
		[
			'MalformedResponseError',
			new MalformedResponseError('boom'),
			genericExitCode
		],
		['ChecksumError', new ChecksumError('boom'), genericExitCode],
		['AttestationError', new AttestationError('boom'), genericExitCode],
		['CachePublicKeyError', new CachePublicKeyError('boom'), genericExitCode],
		['NixError', new NixError('boom'), genericExitCode],
		[
			'CommandFailedError',
			new CommandFailedError('cupboard', 1),
			genericExitCode
		]
	])('%s reports its name and exit code', (name, error, exitCode) => {
		expect({ name: error.name, exitCode: error.exitCode }).toStrictEqual({
			name,
			exitCode
		});
	});
});
