import { describe, expect, it } from 'vitest';

import {
	AdminApiTransientError,
	type AdminApiTransientStatus,
	type IncompletePush,
	overQuotaAdvice,
	PushIncompleteError,
	QuotaExceededError
} from './errors.ts';

describe('QuotaExceededError', () => {
	it.each([
		{
			detail: '',
			equivalent: "The upload would exceed the tenant's storage quota."
		},
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

	it("follows the server's detail with the advice", () => {
		expect(
			new QuotaExceededError(
				"This upload would exceed the tenant's storage quota"
			).message
		).toBe(
			`This upload would exceed the tenant's storage quota. ${overQuotaAdvice}`
		);
	});
});

describe('AdminApiTransientError', () => {
	it.each<{
		status: AdminApiTransientStatus;
		code: string;
		message: string;
	}>([
		{
			status: 408,
			code: 'TIMEOUT',
			message:
				'The admin API responded with 408 (TIMEOUT). Run the command again later.'
		},
		{
			status: 503,
			code: 'CACHE_LISTING_PROJECTION_PENDING',
			message:
				'The admin API responded with 503 (CACHE_LISTING_PROJECTION_PENDING). Run the command again later.'
		}
	])('reports status $status and code $code', ({ status, code, message }) => {
		const error = new AdminApiTransientError(status, code);

		expect({
			exitCode: error.exitCode,
			status: error.status,
			code: error.code,
			message: error.message
		}).toStrictEqual({ exitCode: 75, status, code, message });
	});
});

describe('PushIncompleteError', () => {
	it.each<{ name: string; push: IncompletePush; message: string }>([
		{
			name: 'a transient upload failure with retention to record',
			push: {
				failures: [{ path: 'a-app', stage: 'upload' }],
				exitStatus: 75,
				command: 'cupboard push',
				credential: 'cupboard-login',
				recordsRetention: true
			},
			message:
				'This push did not publish 1 path(s): a-app. The push did not record retention. Run cupboard push again to publish the failed paths.'
		},
		{
			name: 'a failed verification',
			push: {
				failures: [{ path: 'b-lib', stage: 'verify', verdict: 'failed' }],
				exitStatus: 1,
				command: 'cupboard build-push',
				credential: 'cupboard-login',
				recordsRetention: true
			},
			message:
				'Verification failed for 1 committed path(s): b-lib. The push recorded retention before verification. Fix the failure reported above for each path, then run cupboard build-push again.'
		},
		{
			name: 'a verification verdict that the push did not receive, without retention',
			push: {
				failures: [{ path: 'c-doc', stage: 'verify', verdict: 'pending' }],
				exitStatus: 75,
				command: 'cupboard build-push',
				credential: 'cupboard-login',
				recordsRetention: false
			},
			message:
				'The server had not verified 1 committed path(s) when the push stopped waiting: c-doc. It may still publish them. Run cupboard build-push again to publish the failed paths.'
		},
		{
			name: 'failures at every stage with an authentication failure',
			push: {
				failures: [
					{ path: 'a-app', stage: 'upload' },
					{ path: 'b-lib', stage: 'verify', verdict: 'failed' },
					{ path: 'c-doc', stage: 'verify', verdict: 'pending' }
				],
				exitStatus: 77,
				command: 'cupboard push',
				credential: 'cupboard-login',
				recordsRetention: true
			},
			message:
				'This push did not publish 1 path(s): a-app. Verification failed for 1 committed path(s): b-lib. The server had not verified 1 committed path(s) when the push stopped waiting: c-doc. It may still publish them. The push did not record retention. Sign in again with cupboard login or use a credential that allows the push, then run cupboard push again.'
		},
		{
			name: 'an authentication failure of a GitHub OIDC push',
			push: {
				failures: [{ path: 'a-app', stage: 'commit' }],
				exitStatus: 77,
				command: 'cupboard build-push',
				credential: 'github-oidc',
				recordsRetention: false
			},
			message:
				'This push did not publish 1 path(s): a-app. Check that a trust rule of the tenant grants this GitHub workflow the push, then run cupboard build-push again.'
		},
		{
			name: 'an unavailable dependency without retention',
			push: {
				failures: [{ path: 'a-app', stage: 'resolve' }],
				exitStatus: 69,
				command: 'cupboard push',
				credential: 'cupboard-login',
				recordsRetention: false
			},
			message:
				'This push did not publish 1 path(s): a-app. Fix the failure reported above for each path, then run cupboard push again.'
		}
	])('renders $name', ({ push, message }) => {
		const error = new PushIncompleteError(push);

		expect({
			exitCode: error.exitCode,
			failedPaths: error.failedPaths,
			message: error.message
		}).toStrictEqual({
			exitCode: push.exitStatus,
			failedPaths: push.failures.map((failure) => failure.path),
			message
		});
	});
});
