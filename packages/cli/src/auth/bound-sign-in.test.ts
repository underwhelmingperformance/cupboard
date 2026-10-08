import { subjectBindingNonce } from '@cupboard/protocol/subject-binding';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	authExitCode,
	CupboardHttpError,
	OwnerLoginRequiredError
} from '../errors.ts';

import {
	type BoundIdToken,
	BoundSignIn,
	canonicalTarget,
	NonceNotBoundError,
	reusableSignInAgeSeconds,
	type SignInMethod,
	TargetNotAcceptedError
} from './bound-sign-in.ts';

const deployment = canonicalTarget(
	new URL('https://cupboard.example.workers.dev/')
);
const tenant = canonicalTarget(
	new URL('https://cupboard.example.workers.dev/t/acme')
);
const otherTenant = canonicalTarget(
	new URL('https://cupboard.example.workers.dev/t/other')
);

function idToken(claims: Record<string, unknown>): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

	return `e30.${payload}.signature`;
}

interface Browser {
	readonly method: SignInMethod;
	readonly nonces: string[];
	readonly clock: { nowMs: number };
}

// Each sign-in returns a token with the requested nonce, issued at the clock's
// current time.
function browser(options: { readonly bindsNonce?: boolean } = {}): Browser {
	const nonces: string[] = [];
	const clock = { nowMs: 1_700_000_000_000 };

	return {
		nonces,
		clock,
		method: {
			bindsNonce: options.bindsNonce ?? true,
			signIn: (nonce) => {
				nonces.push(nonce);

				return Promise.resolve(
					idToken({
						nonce,
						iat: Math.floor(clock.nowMs / 1000),
						sign_in: nonces.length
					})
				);
			}
		}
	};
}

function signInWith(world: Browser): BoundSignIn {
	return new BoundSignIn(world.method, () => world.clock.nowMs);
}

function refusal(body: Record<string, string>): CupboardHttpError {
	return new CupboardHttpError(
		'POST',
		'/token',
		StatusCodes.BAD_REQUEST,
		JSON.stringify(body)
	);
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
	try {
		await pending;
	} catch (error) {
		return error;
	}

	return undefined;
}

async function bindingNonceOf(token: BoundIdToken): Promise<string> {
	return token.binding === undefined
		? 'unbound'
		: subjectBindingNonce(token.binding.targets, token.binding.seed);
}

describe('BoundSignIn', () => {
	it('reuses the held sign-in for a subset of its targets while it is young enough', async () => {
		const world = browser();
		const signIn = signInWith(world);

		const first = await signIn.idTokenFor([deployment, tenant]);
		world.clock.nowMs += (reusableSignInAgeSeconds - 1) * 1000;
		const second = await signIn.idTokenFor([tenant]);

		expect({
			second,
			targets: first.binding?.targets,
			nonces: world.nonces
		}).toStrictEqual({
			second: first,
			targets: [deployment, tenant],
			nonces: [await bindingNonceOf(first)]
		});
	});

	it.each([
		{
			name: 'the held token is too old',
			arrange: (world: Browser) => {
				world.clock.nowMs += reusableSignInAgeSeconds * 1000;

				return Promise.resolve();
			},
			requested: [tenant]
		},
		{
			name: 'a requested target is not covered',
			arrange: () => Promise.resolve(),
			requested: [tenant, otherTenant]
		},
		{
			name: 'the token was already presented at the target',
			arrange: (_world: Browser, signIn: BoundSignIn) =>
				signIn.present([deployment, tenant], tenant, () =>
					Promise.resolve('session')
				),
			requested: [tenant]
		}
	])('signs in again when $name', async ({ arrange, requested }) => {
		const world = browser();
		const signIn = signInWith(world);

		const first = await signIn.idTokenFor([deployment, tenant]);
		await arrange(world, signIn);
		const second = await signIn.idTokenFor(requested);

		expect({
			targets: second.binding?.targets,
			isNewToken: second.idToken !== first.idToken,
			nonces: world.nonces
		}).toStrictEqual({
			targets: requested,
			isNewToken: true,
			nonces: [await bindingNonceOf(first), await bindingNonceOf(second)]
		});
	});

	it('reuses a token presented at one target for another of its targets', async () => {
		const world = browser();
		const signIn = signInWith(world);

		const claimed = await signIn.present(
			[deployment, tenant],
			deployment,
			(token) => Promise.resolve(token)
		);
		const forTenant = await signIn.idTokenFor([tenant]);

		expect({ forTenant, signIns: world.nonces.length }).toStrictEqual({
			forTenant: claimed,
			signIns: 1
		});
	});

	it.each([
		{ error: 'invalid_grant', problem: 'subject-token-replayed' },
		{ error: 'invalid_grant', problem: 'subject-token-unbound' },
		{ error: 'invalid_grant', problem: 'subject-token-too-old' }
	])(
		'discards the held sign-in and retries once after $problem',
		async (body) => {
			const world = browser();
			const signIn = signInWith(world);
			const presented: string[] = [];

			const outcome = await signIn.present(
				[deployment],
				deployment,
				(token) => {
					presented.push(token.idToken);

					return presented.length === 1
						? Promise.reject(refusal(body))
						: Promise.resolve('session');
				}
			);

			expect({
				outcome,
				signIns: world.nonces.length,
				isNewToken: presented[0] !== presented[1],
				attempts: presented.length
			}).toStrictEqual({
				outcome: 'session',
				signIns: 2,
				isNewToken: true,
				attempts: 2
			});
		}
	);

	it('does not retry a second time after another binding refusal', async () => {
		const world = browser();
		const signIn = signInWith(world);
		const refusals = [
			refusal({ error: 'invalid_grant', problem: 'subject-token-unbound' }),
			refusal({ error: 'invalid_grant', problem: 'subject-token-replayed' })
		];
		let attempts = 0;

		const rejected = await rejectionOf(
			signIn.present([deployment], deployment, () => {
				const thrown = refusals[attempts] ?? new Error('too many attempts');
				attempts += 1;

				return Promise.reject(thrown);
			})
		);

		expect({
			rejected,
			attempts,
			signIns: world.nonces.length
		}).toStrictEqual({
			rejected: refusals[1],
			attempts: 2,
			signIns: 2
		});
	});

	it('says that the server does not accept the URL when the new sign-in is also unbound', async () => {
		const world = browser();
		const signIn = signInWith(world);
		const unbound = refusal({
			error: 'invalid_grant',
			problem: 'subject-token-unbound'
		});
		const presentedTargets: (readonly string[])[] = [];

		const rejected = await rejectionOf(
			signIn.present([tenant], tenant, (token) => {
				presentedTargets.push(token.binding?.targets ?? []);

				return Promise.reject(unbound);
			})
		);

		expect({
			rejected:
				rejected instanceof TargetNotAcceptedError
					? {
							name: rejected.name,
							target: rejected.target,
							cause: rejected.cause,
							exitCode: rejected.exitCode
						}
					: rejected,
			presentedTargets,
			signIns: world.nonces.length
		}).toStrictEqual({
			rejected: {
				name: 'TargetNotAcceptedError',
				target: tenant,
				cause: unbound,
				exitCode: authExitCode
			},
			presentedTargets: [[tenant], [tenant]],
			signIns: 2
		});
	});

	it.each([
		{
			name: 'a refusal for another reason',
			failure: () =>
				refusal({
					error: 'invalid_request',
					problem: 'subject-token-untrusted'
				})
		},
		{
			name: 'a token that fails verification, such as a bad signature',
			failure: () =>
				refusal({
					error: 'invalid_request',
					problem: 'subject-token-invalid'
				})
		},
		{
			name: 'a binding problem on a forbidden response',
			failure: () =>
				new CupboardHttpError(
					'POST',
					'/token',
					StatusCodes.FORBIDDEN,
					JSON.stringify({
						error: 'invalid_grant',
						problem: 'subject-token-replayed'
					})
				)
		}
	])('does not retry after $name', async ({ failure }) => {
		const world = browser();
		const signIn = signInWith(world);
		const thrown = failure();
		let attempts = 0;

		const rejected = await rejectionOf(
			signIn.present([deployment], deployment, () => {
				attempts += 1;

				return Promise.reject(thrown);
			})
		);

		expect({
			rejected,
			attempts,
			signIns: world.nonces.length
		}).toStrictEqual({ rejected: thrown, attempts: 1, signIns: 1 });
	});

	it('keeps the token when an exchange gets no response, for a retry at the same target', async () => {
		const world = browser();
		const signIn = signInWith(world);
		const unanswered = new Error('connection reset');

		const failed = await rejectionOf(
			signIn.present([deployment], deployment, () => Promise.reject(unanswered))
		);
		const retried = await signIn.present([deployment], deployment, (token) =>
			Promise.resolve(token.idToken)
		);
		const first = world.nonces[0];

		expect({ failed, retried, signIns: world.nonces.length }).toStrictEqual({
			failed: unanswered,
			retried: idToken({
				nonce: first,
				iat: Math.floor(world.clock.nowMs / 1000),
				sign_in: 1
			}),
			signIns: 1
		});
	});

	it('throws OwnerLoginRequiredError when it cannot sign in', async () => {
		const signIn = new BoundSignIn(undefined);

		const rejected = await rejectionOf(signIn.idTokenFor([deployment]));

		expect(rejected).toBeInstanceOf(OwnerLoginRequiredError);
	});

	it('refuses an ID token without the requested nonce, and keeps nothing', async () => {
		let signIns = 0;
		const signIn = new BoundSignIn({
			bindsNonce: true,
			signIn: () => {
				signIns += 1;

				return Promise.resolve(idToken({ nonce: 'another', iat: 1 }));
			}
		});

		const first = await rejectionOf(signIn.idTokenFor([deployment]));
		const second = await rejectionOf(signIn.idTokenFor([deployment]));

		expect({
			first: first instanceof NonceNotBoundError,
			second: second instanceof NonceNotBoundError,
			signIns
		}).toStrictEqual({ first: true, second: true, signIns: 2 });
	});

	it('returns an unbound token from a sign-in that cannot request a nonce', async () => {
		const world = browser({ bindsNonce: false });
		const signIn = signInWith(world);

		const token = await signIn.idTokenFor([deployment]);

		expect(token).toStrictEqual({
			idToken: idToken({
				nonce: world.nonces[0],
				iat: Math.floor(world.clock.nowMs / 1000),
				sign_in: 1
			}),
			binding: undefined
		});
	});
});
