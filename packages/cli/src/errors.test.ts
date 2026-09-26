import { describe, expect, it } from 'vitest';

import {
	AdminApiTransientError,
	type AdminApiTransientStatus,
	authExitCode,
	type FailedPushPath,
	type IncompletePushExitStatus,
	type PushCommand,
	PushIncompleteError,
	type PushRetryAdvice,
	QuotaExceededError,
	transientExitCode,
	unavailableExitCode
} from './errors.ts';

describe('QuotaExceededError', () => {
	it.each([
		{ detail: '', equivalent: 'The cache is over its storage quota.' },
		{
			detail: "This upload would exceed the tenant's storage quota",
			equivalent: "This upload would exceed the tenant's storage quota."
		},
		{
			detail: 'Cache builds is over its 10 GB quota. ',
			equivalent: 'Cache builds is over its 10 GB quota.'
		}
	])(
		'gives detail $detail the same message as $equivalent',
		({ detail, equivalent }) => {
			expect(new QuotaExceededError(detail).message).toBe(
				new QuotaExceededError(equivalent).message
			);
		}
	);

	it('gives different details different messages', () => {
		const messages = [
			'Cache builds is over its 10 GB quota.',
			'Cache docs is over its 5 GB quota.'
		].map((detail) => new QuotaExceededError(detail).message);

		expect(new Set(messages).size).toBe(messages.length);
	});
});

describe('AdminApiTransientError', () => {
	it.each<{ status: AdminApiTransientStatus; code: string }>([
		{ status: 408, code: 'TIMEOUT' },
		{ status: 503, code: 'CACHE_LISTING_PROJECTION_PENDING' }
	])('reports status $status and code $code', ({ status, code }) => {
		const error = new AdminApiTransientError(status, code);

		expect({
			exitCode: error.exitCode,
			status: error.status,
			code: error.code,
			mentions: {
				status: error.message.includes(String(status)),
				code: error.message.includes(code)
			}
		}).toStrictEqual({
			exitCode: transientExitCode,
			status,
			code,
			mentions: { status: true, code: true }
		});
	});
});

describe('PushIncompleteError', () => {
	const failures: readonly FailedPushPath[] = [
		{ path: 'a-app', stage: 'upload' },
		{ path: 'b-lib', stage: 'verify' }
	];

	it.each<{
		exitStatus: IncompletePushExitStatus;
		command: PushCommand;
		advice: PushRetryAdvice;
	}>([
		{
			exitStatus: authExitCode,
			command: 'cupboard push',
			advice: { action: 'sign-in', command: 'cupboard push' }
		},
		{
			exitStatus: authExitCode,
			command: 'cupboard build-push',
			advice: { action: 'sign-in', command: 'cupboard build-push' }
		},
		{
			exitStatus: transientExitCode,
			command: 'cupboard push',
			advice: { action: 'retry', command: 'cupboard push' }
		},
		{
			exitStatus: transientExitCode,
			command: 'cupboard build-push',
			advice: { action: 'retry', command: 'cupboard build-push' }
		},
		{
			exitStatus: unavailableExitCode,
			command: 'cupboard build-push',
			advice: { action: 'fix', command: 'cupboard build-push' }
		},
		{
			exitStatus: 1,
			command: 'cupboard push',
			advice: { action: 'fix', command: 'cupboard push' }
		}
	])(
		'exits $exitStatus and advises $advice.action for $command',
		({ exitStatus, command, advice }) => {
			const error = new PushIncompleteError(failures, exitStatus, command);

			expect({
				exitCode: error.exitCode,
				failures: error.failures,
				failedPaths: error.failedPaths,
				advice: error.advice,
				mentions: {
					paths: failures.map((failure) =>
						error.message.includes(failure.path)
					),
					command: error.message.includes(command)
				}
			}).toStrictEqual({
				exitCode: exitStatus,
				failures,
				failedPaths: ['a-app', 'b-lib'],
				advice,
				mentions: { paths: [true, true], command: true }
			});
		}
	);
});
