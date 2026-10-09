import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AuthorizationAccessDeniedError } from './auth/oidc-login.ts';
import {
	CliError,
	CupboardHttpError,
	InvalidCacheCredentialsError,
	ReferenceSourceReadRefusedError,
	ScopeForbiddenError,
	SessionRejectedError,
	TransitionIncompleteError,
	UnreachableHostError
} from './errors.ts';
import { formatHumanError } from './human-errors.ts';

const target = new URL('https://cupboard.example.workers.dev/t/acme');

describe('human error presentation', () => {
	it.each([undefined, 'v0.0.34'])(
		'keeps blocked-upgrade recovery safe at each presentation level (%s)',
		(completedBy) => {
			const error = new TransitionIncompleteError(
				'cache-identity',
				'blob-reference-read-authority',
				completedBy
			);
			const summary =
				'An earlier upgrade must complete before this release can be deployed. Run again with --debug to check which releases can complete the upgrade before choosing an intermediate release. ' +
				(completedBy === undefined
					? 'Do not deploy a release older than the currently deployed release. '
					: `The intermediate release must be ${completedBy} or later and must not be older than the currently deployed release. `) +
				'If the currently deployed release is compatible, rerun it with the same source to finish the earlier upgrade, then deploy this release.';

			expect({
				summary: formatHumanError(error),
				details: formatHumanError(error, { debug: false }),
				debug: formatHumanError(error, { debug: true })
			}).toStrictEqual({
				summary,
				details: summary,
				debug: `${summary}\n${error.message}`
			});
		}
	);

	it.each([
		{
			error: new AuthorizationAccessDeniedError(),
			expected:
				'Sign-in was declined. Run `cupboard login https://cupboard.example.workers.dev/t/acme` again to authorise access.'
		},
		{
			error: new ScopeForbiddenError(),
			expected:
				'You do not have permission to publish for https://cupboard.example.workers.dev/t/acme. Ask the tenant administrator or deployment operator to grant this access.'
		},
		{
			error: new SessionRejectedError({
				cause: new Error('UNAUTHORIZED internals')
			}),
			expected:
				'Your saved sign-in was refused. Run `cupboard login https://cupboard.example.workers.dev/t/acme` to sign in again.'
		},
		{
			error: new UnreachableHostError(
				'cupboard.example.workers.dev',
				new Error('fetch failed')
			),
			expected:
				'Could not connect to cupboard.example.workers.dev. Check the deployment URL and your network connection, then retry.'
		},
		{
			error: new CupboardHttpError(
				'POST',
				'/upload/negotiate',
				500,
				'<html>provider internals</html>'
			),
			expected:
				'The server could not complete the request. Publication may be incomplete. Check its status before retrying.'
		},
		{
			error: new ReferenceSourceReadRefusedError(
				[new URL('https://cupboard.example.workers.dev/t/acme/reuse/prs')],
				{
					cause: new CupboardHttpError(
						'POST',
						'/t/acme/oauth/token',
						400,
						'{"error":"invalid_authorization_details","problem":"not-permitted"}'
					)
				}
			),
			expected:
				'The trust rule refused this push token request, which includes read access to the private reference source https://cupboard.example.workers.dev/t/acme/reuse/prs. Run `cupboard github check` to check the source read grants and destination publication grants.'
		},
		{
			error: new ORPCError('UNRECOGNISED', {
				message: 'private SQL internals'
			}),
			expected:
				'Could not publish for https://cupboard.example.workers.dev/t/acme. Run again with --debug for diagnostic information.'
		}
	])(
		'describes $error.name without protocol details',
		({ error, expected }) => {
			expect(formatHumanError(error, { action: 'publish', target })).toBe(
				expected
			);
		}
	);

	it('keeps field constraints without rendering validator issues', () => {
		const parsed = z
			.object({ password: z.string() })
			.safeParse({ password: 42 });

		if (parsed.success) {
			throw new Error('Expected invalid credentials');
		}

		expect(
			formatHumanError(
				new InvalidCacheCredentialsError({ cause: parsed.error })
			)
		).toBe('Invalid cache credentials. password: expected string.');
	});

	it('includes original error diagnostics only when requested', () => {
		const error = new SessionRejectedError({
			cause: new Error('provider refused request')
		});

		expect(formatHumanError(error, { debug: true, target })).toContain(
			'provider refused request'
		);
		expect(formatHumanError(error, { target })).not.toContain(
			'provider refused request'
		);
	});
	it('redacts credentials in diagnostic causes without changing the error', () => {
		const cause = new Error(
			'Authorization: Bearer sensitive-token; https://user:password@cupboard.example.workers.dev?access_token=secret&attempt=2'
		);
		const error = new SessionRejectedError({ cause });
		const rendered = formatHumanError(error, { debug: true });

		expect({ rendered, cause: error.cause }).toStrictEqual({
			rendered:
				'Your saved sign-in was refused. Run `cupboard login <url>` to sign in again.\nThe server refused your session; it may have expired. Run `cupboard login <url>` to sign in again.\n  Error: Authorization: Bearer [redacted]; https://[redacted]@cupboard.example.workers.dev?access_token=[redacted]&attempt=2',
			cause
		});
	});

	it.each([
		[
			'CACHE_ACCESS_MIGRATION_PENDING',
			'The cache access change is still being applied. Check the cache settings before retrying.'
		],
		[
			'CACHE_RETENTION_MIGRATION_PENDING',
			'The cache retention change is still being applied. Check the cache settings before retrying.'
		],
		[
			'OIDC_TRUST_RULE_CHANGED',
			'The trust rule changed while this command was running. Review the current rule and run the command again.'
		],
		[
			'CACHE_NOT_EMPTY',
			'The cache still contains published paths. Review the contents and remove the paths before removing the cache, or use --force after reviewing the consequences.'
		]
	])('explains %s without backend mechanisms', (code, expected) => {
		expect(
			formatHumanError(new ORPCError(code, { message: 'projection SQL' }))
		).toBe(expected);
	});

	it('does not treat an unmapped CLI subclass as approved operator prose', () => {
		class InternalFailure extends CliError {}
		const error = new InternalFailure('Private database implementation');
		expect(
			formatHumanError(error, { action: 'check the deployment', target })
		).toBe(
			'Could not check the deployment for https://cupboard.example.workers.dev/t/acme. Run again with --debug for diagnostic information.'
		);
	});

	it.each([
		'SIGNING_KEY_ROTATION_IN_PROGRESS',
		'SIGNING_KEY_BACKFILL_INCOMPLETE',
		'SIGNING_KEY_ROTATION_ABORT_NOT_ALLOWED'
	])('uses the selected target in %s recovery instructions', (code) => {
		expect(formatHumanError(new ORPCError(code), { target })).toContain(
			'`cupboard key status https://cupboard.example.workers.dev/t/acme`'
		);
	});

	it('describes a typed OAuth refusal without copying provider diagnostics', () => {
		const error = new CupboardHttpError(
			'POST',
			'/oauth/token',
			400,
			JSON.stringify({
				error: 'invalid_request',
				problem: 'subject-token-untrusted',
				error_description: 'private provider internals'
			})
		);
		expect(formatHumanError(error, { target })).toBe(
			'This sign-in identity is not trusted for the requested access. Ask the tenant administrator or deployment operator to review the trust rules for the identity provider.'
		);
	});
});
