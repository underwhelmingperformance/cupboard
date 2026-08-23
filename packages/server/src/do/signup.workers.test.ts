import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { enforceGate, handleSignup } from '../control/signup.ts';
import { SignupForbiddenError, SubjectTokenNotJwtError } from '../errors.ts';
import {
	controlFetch,
	currentOrigin,
	resetTestServer,
	testControlEnv
} from '../test-support.ts';

const oauthErrorSchema = z.strictObject({
	error: z.string(),
	error_description: z.string().min(1),
	problem: z.string().optional()
});

function oauthErrorShape(value: unknown): z.infer<typeof oauthErrorSchema> {
	return oauthErrorSchema.parse(value);
}

function postSignup(
	form: Record<string, string>,
	envOverride: Readonly<Record<string, string>> = {}
): Promise<Response> {
	const body = new URLSearchParams(form);
	return controlFetch(
		'/signup',
		{
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		},
		envOverride
	);
}

function signupRequest(form: Record<string, string>): Request {
	const body = new URLSearchParams(form);
	return new Request(new URL('/signup', currentOrigin()), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
}

async function signupError(form: Record<string, string>): Promise<unknown> {
	try {
		return await handleSignup(
			signupRequest(form),
			Object.assign({}, env, testControlEnv)
		);
	} catch (error: unknown) {
		return error;
	}
}

type SignupGateOutcome =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly error: {
				readonly name: string;
				readonly status: number;
			};
	  };

const gateAllowed: SignupGateOutcome = { allowed: true };
const gateForbidden: SignupGateOutcome = {
	allowed: false,
	error: {
		name: 'SignupForbiddenError',
		status: StatusCodes.FORBIDDEN
	}
};

async function gateOutcome(
	gateEnv: Parameters<typeof enforceGate>[0],
	claimSecret: string | undefined,
	subject: string
): Promise<SignupGateOutcome> {
	try {
		await enforceGate(gateEnv, claimSecret, subject);

		return gateAllowed;
	} catch (error) {
		if (!(error instanceof SignupForbiddenError)) {
			throw error;
		}

		return {
			allowed: false,
			error: {
				name: error.name,
				status: error.status
			}
		};
	}
}

async function signedToken(options: {
	issuer: string;
	audience: string;
	subject?: string;
}): Promise<string> {
	const { privateKey } = await generateKeyPair('RS256', { extractable: true });

	const jwt = new SignJWT({});
	return jwt
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
			name: 'accepts a matching claim secret',
			secret: 'sssh',
			pinned: '',
			localDev: '',
			claimSecret: 'sssh',
			subject: 'owner',
			expected: gateAllowed
		},
		{
			name: 'rejects an incorrect claim secret',
			secret: 'sssh',
			pinned: '',
			localDev: '',
			claimSecret: 'nope',
			subject: 'owner',
			expected: gateForbidden
		},
		{
			name: 'rejects a missing claim secret',
			secret: 'sssh',
			pinned: '',
			localDev: '',
			claimSecret: undefined,
			subject: 'owner',
			expected: gateForbidden
		},
		{
			name: 'accepts a matching pinned subject',
			secret: '',
			pinned: 'owner',
			localDev: '',
			claimSecret: undefined,
			subject: 'owner',
			expected: gateAllowed
		},
		{
			name: 'accepts a pinned subject when the secret binding is absent',
			secret: undefined,
			pinned: 'owner',
			localDev: '',
			claimSecret: undefined,
			subject: 'owner',
			expected: gateAllowed
		},
		{
			name: 'rejects hosted signup when every gate binding is absent',
			secret: undefined,
			pinned: undefined,
			localDev: undefined,
			claimSecret: undefined,
			subject: 'owner',
			expected: gateForbidden
		},
		{
			name: 'rejects a non-matching pinned subject',
			secret: '',
			pinned: 'owner',
			localDev: '',
			claimSecret: undefined,
			subject: 'intruder',
			expected: gateForbidden
		},
		{
			name: 'accepts local development without a configured gate',
			secret: '',
			pinned: '',
			localDev: '1',
			claimSecret: undefined,
			subject: 'owner',
			expected: gateAllowed
		},
		{
			name: 'rejects hosted signup without a configured gate',
			secret: '',
			pinned: '',
			localDev: '',
			claimSecret: undefined,
			subject: 'owner',
			expected: gateForbidden
		}
	])(
		'$name',
		async ({ secret, pinned, localDev, claimSecret, subject, expected }) => {
			const gateEnv = {
				CUPBOARD_SIGNUP_SECRET: secret,
				CUPBOARD_SIGNUP_SUBJECT: pinned,
				CUPBOARD_LOCAL_DEV: localDev
			};

			expect(await gateOutcome(gateEnv, claimSecret, subject)).toStrictEqual(
				expected
			);
		}
	);
});

describe('control plane POST /signup', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rejects a subject token that is not a JWT', async () => {
		const error = await signupError({ subject_token: 'not-a-jwt' });

		expect(error).toBeInstanceOf(SubjectTokenNotJwtError);
	});

	it('renders an OAuth error as a no-store envelope', async () => {
		const response = await postSignup({ subject_token: 'not-a-jwt' });
		const body = oauthErrorShape(await response.json());

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			error: body.error,
			problem: body.problem
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			cacheControl: 'no-store',
			error: 'invalid_request',
			problem: 'subject-token-invalid'
		});
	});

	it.each([
		{ name: 'unconfigured', configured: '' },
		{ name: 'not an issuer URL', configured: 'http://issuer.example.test' }
	])('reports 500 when the signup issuer is $name', async ({ configured }) => {
		const response = await postSignup(
			{ subject_token: 'x' },
			{ CUPBOARD_SIGNUP_ISSUER: configured }
		);
		await response.text();

		expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
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
