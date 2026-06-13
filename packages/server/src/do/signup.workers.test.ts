import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enforceGate } from '../control/signup.ts';
import { SignupForbiddenError } from '../errors.ts';
import {
	controlFetch,
	currentOrigin,
	resetTestServer
} from '../test-support.ts';

interface OAuthError {
	readonly error: string;
	readonly error_description: string;
}

function postSignup(
	form: Record<string, string>,
	envOverride: Readonly<Record<string, string>> = {}
): Promise<Response> {
	return controlFetch(
		'/signup',
		{
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(form).toString()
		},
		envOverride
	);
}

// A well-formed token for a given issuer/audience. Issuer discovery or key
// retrieval is unavailable in these tests, so verification never confirms the
// signature.
async function signedToken(options: {
	issuer: string;
	audience: string;
	subject?: string;
}): Promise<string> {
	const { privateKey } = await generateKeyPair('RS256', { extractable: true });

	return new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
		.setIssuer(options.issuer)
		.setAudience(options.audience)
		.setSubject(options.subject ?? 'someone')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);
}

describe('signup gate', () => {
	it.each([
		{
			name: 'a matching claim secret',
			secret: 'sssh',
			pinned: '',
			localDev: '',
			claimSecret: 'sssh',
			subject: 'owner',
			allowed: true
		},
		{
			name: 'a wrong claim secret',
			secret: 'sssh',
			pinned: '',
			localDev: '',
			claimSecret: 'nope',
			subject: 'owner',
			allowed: false
		},
		{
			name: 'a missing claim secret',
			secret: 'sssh',
			pinned: '',
			localDev: '',
			claimSecret: undefined,
			subject: 'owner',
			allowed: false
		},
		{
			name: 'a matching pinned subject',
			secret: '',
			pinned: 'owner',
			localDev: '',
			claimSecret: undefined,
			subject: 'owner',
			allowed: true
		},
		{
			// A deployment that never ran `wrangler secret put` has no secret
			// binding at all: the env reads as undefined, not the empty string.
			name: 'a pinned subject with the secret binding absent',
			secret: undefined,
			pinned: 'owner',
			localDev: '',
			claimSecret: undefined,
			subject: 'owner',
			allowed: true
		},
		{
			name: 'every gate binding absent in hosted mode',
			secret: undefined,
			pinned: undefined,
			localDev: undefined,
			claimSecret: undefined,
			subject: 'owner',
			allowed: false
		},
		{
			name: 'a wrong pinned subject',
			secret: '',
			pinned: 'owner',
			localDev: '',
			claimSecret: undefined,
			subject: 'intruder',
			allowed: false
		},
		{
			name: 'no gate with local dev relaxed',
			secret: '',
			pinned: '',
			localDev: '1',
			claimSecret: undefined,
			subject: 'owner',
			allowed: true
		},
		{
			name: 'no gate in hosted mode',
			secret: '',
			pinned: '',
			localDev: '',
			claimSecret: undefined,
			subject: 'owner',
			allowed: false
		}
	])(
		'$name: allowed=$allowed',
		({ secret, pinned, localDev, claimSecret, subject, allowed }) => {
			const gateEnv = {
				CUPBOARD_SIGNUP_SECRET: secret,
				CUPBOARD_SIGNUP_SUBJECT: pinned,
				CUPBOARD_LOCAL_DEV: localDev
			};

			const call = (): void => {
				enforceGate(gateEnv, claimSecret, subject);
			};

			if (allowed) {
				expect(call).not.toThrow();
				return;
			}

			expect(call).toThrow(SignupForbiddenError);
		}
	);
});

describe('control plane POST /signup', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rejects a subject token that is not a JWT with invalid_grant', async () => {
		const response = await postSignup({ subject_token: 'not-a-jwt' });
		const body = await response.json<OAuthError>();

		expect({ status: response.status, error: body.error }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			error: 'invalid_grant'
		});
	});

	it('reports 503 when the signup issuer is unconfigured, issuing nothing', async () => {
		const response = await postSignup(
			{ subject_token: 'x' },
			{ CUPBOARD_SIGNUP_ISSUER: '' }
		);
		await response.text();

		expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
	});

	it('reports 503 when the configured issuer is unavailable', async () => {
		const issuer = currentOrigin();
		const subjectToken = await signedToken({
			issuer,
			audience: 'cupboard-control-client',
			subject: 'owner'
		});
		vi.stubGlobal('fetch', () =>
			Promise.reject(new Error('issuer is unavailable'))
		);

		const response = await postSignup(
			{ subject_token: subjectToken },
			{ CUPBOARD_SIGNUP_ISSUER: issuer }
		);
		await response.text();

		expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
	});
});
