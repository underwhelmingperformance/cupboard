import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { enforceClaimSecret, handleSignup } from '../control/signup.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	SignupForbiddenError,
	SubjectTokenAudienceInvalidError,
	SubjectTokenIssuerInvalidError,
	SubjectTokenNotJwtError,
	SubjectTokenVerificationFailedError
} from '../errors.ts';
import {
	controlFetch,
	currentOrigin,
	resetTestServer,
	testControlEnv
} from '../test-support.ts';

const claimSecret = 'one-time-claim-secret';
const claimEnv: { readonly CUPBOARD_SIGNUP_SECRET: string } = {
	CUPBOARD_SIGNUP_SECRET: claimSecret
};

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
	envOverride: Readonly<Record<string, string>> = claimEnv
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
			Object.assign({}, env, testControlEnv, claimEnv)
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
	secret: string | undefined,
	presented: string | undefined
): Promise<SignupGateOutcome> {
	try {
		await enforceClaimSecret({ CUPBOARD_SIGNUP_SECRET: secret }, presented);

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

/**
An OIDC issuer served through the stubbed fetch, recording every request.
*/
interface StubIssuer {
	readonly issuer: string;
	readonly fetched: string[];
	sign(claims: {
		readonly subject: string;
		readonly audience: string | readonly string[];
	}): Promise<string>;
}

async function stubIssuer(
	issuer = `https://idp-${crypto.randomUUID()}.example.test`
): Promise<StubIssuer> {
	const { publicKey, privateKey } = await generateKeyPair('RS256', {
		extractable: true
	});
	const publicJwk = await exportJWK(publicKey);
	const fetched: string[] = [];

	vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		fetched.push(url);

		if (url === `${issuer}/.well-known/openid-configuration`) {
			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: `${issuer}/jwks`,
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		}

		if (url === `${issuer}/jwks`) {
			return Promise.resolve(
				Response.json({
					keys: [{ ...publicJwk, kid: 'idp', alg: 'RS256', use: 'sig' }]
				})
			);
		}

		return Promise.resolve(
			new Response(undefined, { status: StatusCodes.NOT_FOUND })
		);
	});

	return {
		issuer,
		fetched,
		sign: ({ subject, audience }) =>
			new SignJWT({})
				.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
				.setIssuer(issuer)
				.setAudience([
					...(typeof audience === 'string' ? [audience] : audience)
				])
				.setSubject(subject)
				.setIssuedAt()
				.setExpirationTime('5m')
				.sign(privateKey)
	};
}

function jwtSegment(value: unknown): string {
	return btoa(JSON.stringify(value))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

async function seededAdmin(): Promise<{
	readonly admin:
		undefined | { issuer: string; subject: string; audience: string };
	readonly trust: { issuer: string; audience: string; claimsJson: string }[];
}> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const admin = await database
		.select({
			issuer: d1Schema.globalAdmin.issuer,
			subject: d1Schema.globalAdmin.subject,
			audience: d1Schema.globalAdmin.audience
		})
		.from(d1Schema.globalAdmin)
		.get();
	const trust = await database
		.select({
			issuer: d1Schema.controlTrust.issuer,
			audience: d1Schema.controlTrust.audience,
			claimsJson: d1Schema.controlTrust.claimsJson
		})
		.from(d1Schema.controlTrust)
		.all();

	return { admin, trust };
}

describe('signup claim secret', () => {
	it.each([
		{
			name: 'accepts the matching secret',
			secret: claimSecret,
			presented: claimSecret,
			expected: gateAllowed
		},
		{
			name: 'refuses a wrong secret',
			secret: claimSecret,
			presented: 'nope',
			expected: gateForbidden
		},
		{
			name: 'refuses a missing secret',
			secret: claimSecret,
			presented: undefined,
			expected: gateForbidden
		},
		{
			name: 'refuses every claim when the Worker has no secret',
			secret: undefined,
			presented: claimSecret,
			expected: gateForbidden
		},
		{
			name: 'refuses an empty secret on the Worker',
			secret: '',
			presented: '',
			expected: gateForbidden
		}
	])('$name', async ({ secret, presented, expected }) => {
		expect(await gateOutcome(secret, presented)).toStrictEqual(expected);
	});
});

describe('control plane POST /signup', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each<{
		readonly name: string;
		readonly form: Readonly<Record<string, string>>;
	}>([
		{ name: 'a wrong', form: { claim_secret: 'wrong' } },
		{ name: 'a missing', form: {} }
	])(
		'refuses $name claim secret before any discovery fetch',
		async ({ form }) => {
			const idp = await stubIssuer();
			const subjectToken = await idp.sign({
				subject: 'founder',
				audience: 'cupboard-client'
			});

			const response = await postSignup({
				subject_token: subjectToken,
				...form
			});
			await response.text();

			expect({
				status: response.status,
				fetched: idp.fetched,
				...(await seededAdmin())
			}).toStrictEqual({
				status: StatusCodes.FORBIDDEN,
				fetched: [],
				admin: undefined,
				trust: []
			});
		}
	);

	it('refuses every claim on a local Worker without a secret', async () => {
		const idp = await stubIssuer();
		const subjectToken = await idp.sign({
			subject: 'founder',
			audience: 'cupboard-client'
		});

		const response = await postSignup(
			{ subject_token: subjectToken, claim_secret: claimSecret },
			{ CUPBOARD_SIGNUP_SECRET: '', CUPBOARD_LOCAL_DEV: '1' }
		);
		await response.text();

		expect({
			status: response.status,
			fetched: idp.fetched,
			...(await seededAdmin())
		}).toStrictEqual({
			status: StatusCodes.FORBIDDEN,
			fetched: [],
			admin: undefined,
			trust: []
		});
	});

	it.each([
		{ name: 'Cloudflare', issuer: 'https://dash.cloudflare.com' },
		{ name: 'another issuer', issuer: undefined }
	])('seeds the admin from a token issued by $name', async ({ issuer }) => {
		const idp = await stubIssuer(issuer);
		const response = await postSignup({
			subject_token: await idp.sign({
				subject: 'founder',
				audience: 'cupboard-client'
			}),
			claim_secret: claimSecret
		});

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			body: await response.json(),
			...(await seededAdmin())
		}).toStrictEqual({
			status: StatusCodes.OK,
			cacheControl: 'no-store',
			body: {
				issuer: idp.issuer,
				subject: 'founder',
				audience: 'cupboard-client',
				claimed: true
			},
			admin: {
				issuer: idp.issuer,
				subject: 'founder',
				audience: 'cupboard-client'
			},
			trust: [
				{
					issuer: idp.issuer,
					audience: 'cupboard-client',
					claimsJson: JSON.stringify({ sub: 'founder' })
				}
			]
		});
	});

	it('seeds the audience from an aud array with one value', async () => {
		const idp = await stubIssuer();
		const response = await postSignup({
			subject_token: await idp.sign({
				subject: 'founder',
				audience: ['cupboard-client']
			}),
			claim_secret: claimSecret
		});

		const { admin } = await seededAdmin();

		expect({
			status: response.status,
			admin
		}).toStrictEqual({
			status: StatusCodes.OK,
			admin: {
				issuer: idp.issuer,
				subject: 'founder',
				audience: 'cupboard-client'
			}
		});
	});

	it('refuses a second principal once the admin is claimed', async () => {
		const idp = await stubIssuer();
		const first = await postSignup({
			subject_token: await idp.sign({
				subject: 'founder',
				audience: 'cupboard-client'
			}),
			claim_secret: claimSecret
		});
		const repeat = await postSignup({
			subject_token: await idp.sign({
				subject: 'founder',
				audience: 'cupboard-client'
			}),
			claim_secret: claimSecret
		});
		const intruder = await postSignup({
			subject_token: await idp.sign({
				subject: 'intruder',
				audience: 'cupboard-client'
			}),
			claim_secret: claimSecret
		});
		await Promise.all([first.text(), repeat.text(), intruder.text()]);

		const { admin } = await seededAdmin();

		expect({
			first: first.status,
			repeat: repeat.status,
			intruder: intruder.status,
			admin
		}).toStrictEqual({
			first: StatusCodes.OK,
			repeat: StatusCodes.OK,
			intruder: StatusCodes.CONFLICT,
			admin: {
				issuer: idp.issuer,
				subject: 'founder',
				audience: 'cupboard-client'
			}
		});
	});

	it('refuses an aud array with more than one value, before discovery', async () => {
		const idp = await stubIssuer();
		const form = {
			subject_token: await idp.sign({
				subject: 'founder',
				audience: ['cupboard-client', 'another-client']
			}),
			claim_secret: claimSecret
		};
		const response = await postSignup(form);
		const body = oauthErrorShape(await response.json());
		const { admin } = await seededAdmin();
		const error = await signupError(form);

		expect({
			status: response.status,
			problem: body.problem,
			isAudienceError: error instanceof SubjectTokenAudienceInvalidError,
			fetched: idp.fetched,
			admin
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			problem: 'subject-token-invalid',
			isAudienceError: true,
			fetched: [],
			admin: undefined
		});
	});

	it.each<{ readonly name: string; readonly aud: unknown }>([
		{ name: 'a number', aud: 123 },
		{ name: 'an object', aud: {} },
		{ name: 'a boolean', aud: false },
		{ name: 'an empty array', aud: [] },
		{ name: 'an empty string', aud: '' },
		{ name: 'an array with an empty string', aud: [''] },
		{ name: 'an array with a number', aud: [123] },
		{ name: 'an array with a string and a number', aud: ['cupboard-client', 7] }
	])(
		'refuses an aud claim that is $name, before discovery',
		async ({ aud }) => {
			const idp = await stubIssuer();
			const subjectToken = [
				jwtSegment({ alg: 'RS256', kid: 'idp' }),
				jwtSegment({ iss: idp.issuer, sub: 'founder', aud }),
				'signature'
			].join('.');

			const form = { subject_token: subjectToken, claim_secret: claimSecret };
			const response = await postSignup(form);
			const body = oauthErrorShape(await response.json());
			const { admin } = await seededAdmin();
			const error = await signupError(form);

			expect({
				status: response.status,
				problem: body.problem,
				isAudienceError: error instanceof SubjectTokenAudienceInvalidError,
				fetched: idp.fetched,
				admin
			}).toStrictEqual({
				status: StatusCodes.BAD_REQUEST,
				problem: 'subject-token-invalid',
				isAudienceError: true,
				fetched: [],
				admin: undefined
			});
		}
	);

	it.each([
		{ name: 'plain HTTP', issuer: 'http://issuer.example.test' },
		{
			// Loopback HTTP is allowed only under CUPBOARD_LOCAL_DEV, which the
			// default environment of this suite does not set.
			name: 'loopback HTTP without CUPBOARD_LOCAL_DEV',
			issuer: 'http://127.0.0.1:8787'
		},
		{ name: 'not a URL', issuer: 'issuer' },
		{
			name: 'a URL with a query string',
			issuer: 'https://issuer.example.test?x=1'
		}
	])(
		'refuses a token whose issuer is $name, before discovery',
		async ({ issuer }) => {
			const idp = await stubIssuer();
			const { privateKey } = await generateKeyPair('RS256');
			const subjectToken = await new SignJWT({})
				.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
				.setIssuer(issuer)
				.setAudience('cupboard-client')
				.setSubject('founder')
				.setIssuedAt()
				.setExpirationTime('5m')
				.sign(privateKey);

			const form = { subject_token: subjectToken, claim_secret: claimSecret };
			const response = await postSignup(form);
			const body = oauthErrorShape(await response.json());
			const error = await signupError(form);

			expect({
				status: response.status,
				problem: body.problem,
				isIssuerError: error instanceof SubjectTokenIssuerInvalidError,
				fetched: idp.fetched
			}).toStrictEqual({
				status: StatusCodes.BAD_REQUEST,
				problem: 'subject-token-invalid',
				isIssuerError: true,
				fetched: []
			});
		}
	);

	it.each<{ readonly name: string; readonly claims: object }>([
		{ name: 'no iss claim', claims: {} },
		{ name: 'a numeric iss claim', claims: { iss: 42 } },
		{
			name: 'an array iss claim',
			claims: { iss: ['https://idp.example.test'] }
		}
	])('refuses a token with $name, before discovery', async ({ claims }) => {
		const idp = await stubIssuer();
		const subjectToken = [
			jwtSegment({ alg: 'RS256', kid: 'idp' }),
			jwtSegment({ ...claims, sub: 'founder', aud: 'cupboard-client' }),
			'signature'
		].join('.');

		const form = { subject_token: subjectToken, claim_secret: claimSecret };
		const response = await postSignup(form);
		const body = oauthErrorShape(await response.json());
		const error = await signupError(form);

		expect({
			status: response.status,
			problem: body.problem,
			isIssuerError: error instanceof SubjectTokenIssuerInvalidError,
			fetched: idp.fetched
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			problem: 'subject-token-invalid',
			isIssuerError: true,
			fetched: []
		});
	});

	it('seeds the admin from a loopback HTTP issuer under CUPBOARD_LOCAL_DEV', async () => {
		const idp = await stubIssuer('http://127.0.0.1:8787');
		const response = await postSignup(
			{
				subject_token: await idp.sign({
					subject: 'founder',
					audience: 'cupboard-client'
				}),
				claim_secret: claimSecret
			},
			{ ...claimEnv, CUPBOARD_LOCAL_DEV: '1' }
		);
		await response.text();

		const { admin } = await seededAdmin();

		expect({ status: response.status, admin }).toStrictEqual({
			status: StatusCodes.OK,
			admin: {
				issuer: 'http://127.0.0.1:8787',
				subject: 'founder',
				audience: 'cupboard-client'
			}
		});
	});

	it('refuses a token signed by another key', async () => {
		const idp = await stubIssuer();
		const { privateKey } = await generateKeyPair('RS256');
		const forged = await new SignJWT({})
			.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
			.setIssuer(idp.issuer)
			.setAudience('cupboard-client')
			.setSubject('founder')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey);

		const form = { subject_token: forged, claim_secret: claimSecret };
		const response = await postSignup(form);
		const body = oauthErrorShape(await response.json());

		const { admin } = await seededAdmin();
		const error = await signupError(form);

		expect({
			status: response.status,
			problem: body.problem,
			isVerificationError: error instanceof SubjectTokenVerificationFailedError,
			admin
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			problem: 'subject-token-invalid',
			isVerificationError: true,
			admin: undefined
		});
	});

	it('rejects a subject token that is not a JWT', async () => {
		const error = await signupError({
			subject_token: 'not-a-jwt',
			claim_secret: claimSecret
		});

		expect(error).toBeInstanceOf(SubjectTokenNotJwtError);
	});

	it('renders an OAuth error as a no-store envelope', async () => {
		const response = await postSignup({
			subject_token: 'not-a-jwt',
			claim_secret: claimSecret
		});
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

	it('reports 503 when the token issuer is unavailable', async () => {
		const issuer = `https://idp-${crypto.randomUUID()}.example.test`;
		const { privateKey } = await generateKeyPair('RS256');
		const subjectToken = await new SignJWT({})
			.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
			.setIssuer(issuer)
			.setAudience('cupboard-client')
			.setSubject('founder')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey);
		vi.stubGlobal('fetch', () =>
			Promise.reject(new Error('issuer is unavailable'))
		);

		const response = await postSignup({
			subject_token: subjectToken,
			claim_secret: claimSecret
		});
		await response.text();

		expect(response.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
	});
});
