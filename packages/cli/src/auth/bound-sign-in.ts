import { randomBytes } from 'node:crypto';

import { canonicalHref } from '@cupboard/nix-store/url';
import {
	isCanonicalTarget,
	subjectBindingNonce,
	subjectBindingProblems
} from '@cupboard/protocol/subject-binding';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import {
	authExitCode,
	CliError,
	CupboardHttpError,
	OwnerLoginRequiredError
} from '../errors.ts';

import { decodeJwtPayload } from './jwt.ts';
import { hasOAuthErrorCode, oauthErrorProblem } from './oauth-error.ts';

const canonicalTargetSchema = z
	.string()
	.refine(isCanonicalTarget)
	.brand<'CanonicalTarget'>();

/**
 * A server URL in the form that `canonicalHref` produces. A nonce-bound ID
 * token commits to a list of these, and each server accepts the token only if
 * its own URL is in the list.
 */
export type CanonicalTarget = z.infer<typeof canonicalTargetSchema>;

export function canonicalTarget(url: URL): CanonicalTarget {
	return canonicalTargetSchema.parse(canonicalHref(url));
}

/**
 * The seed and targets that a token request sends so that the server can
 * recompute the ID token's nonce.
 */
export interface SubjectTokenBinding {
	readonly seed: string;
	readonly targets: readonly CanonicalTarget[];
}

export interface BoundIdToken {
	readonly idToken: string;
	readonly binding: SubjectTokenBinding;
}

/**
 * Opens one sign-in with the identity provider, with `nonce` in the
 * authorisation request, and returns its ID token.
 */
export interface SignInMethod {
	signIn(nonce: string): Promise<string>;
}

/**
 * The form fields that bind a token request to `binding`, or none for a token
 * without a nonce binding, such as a CI token whose audience is its target.
 */
export function bindingFormFields(
	binding: SubjectTokenBinding | undefined
): Readonly<Record<string, string>> {
	if (binding === undefined) {
		return {};
	}

	return {
		cupboard_binding_seed: binding.seed,
		cupboard_binding_targets: JSON.stringify(binding.targets)
	};
}

/**
 * The server refuses a nonce-bound token more than five minutes after its
 * `iat`. A held sign-in is reused only while it is younger than this, which
 * leaves a minute for the request and for clock differences.
 */
export const reusableSignInAgeSeconds = 240;

export class NonceNotBoundError extends CliError {
	override readonly humanMessage =
		'The sign-in returned an ID token that was not issued for this request. The CLI did not send this token to cupboard. Sign in again.';

	constructor() {
		super(
			'The ID token from the identity provider does not contain the nonce ' +
				'that this sign-in requested, so it was not used. Sign in again.'
		);
		this.name = 'NonceNotBoundError';
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

/**
 * The server at `target` refused a token bound to `target` twice with
 * `subject-token-unbound`. The usual cause is that `target` is another URL of
 * the deployment, such as its workers.dev URL when the deployment or tenant
 * was set up at a custom domain. The server compares the targets with the URL
 * that it was set up with.
 */
export class TargetNotAcceptedError extends CliError {
	override readonly humanMessage: string;

	constructor(
		public readonly target: CanonicalTarget,
		options: { readonly cause: unknown }
	) {
		super(
			`${target} refused the sign-in because it does not accept this URL as ` +
				'its own. Sign in at the URL that the deployment or tenant was set up ' +
				'with, for example its custom domain if it has one.',
			options
		);
		this.name = 'TargetNotAcceptedError';
		this.humanMessage = this.message;
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

const idTokenClaimsSchema = z.looseObject({
	nonce: z.string().optional(),
	iat: z.number().optional()
});

interface HeldSignIn {
	readonly token: BoundIdToken;
	readonly issuedAtSeconds: number | undefined;
	readonly presentedAt: Set<CanonicalTarget>;
}

/**
 * Returns ID tokens for the caller's targets and starts another sign-in when
 * the previous token cannot be reused.
 *
 * It keeps its last sign-in in memory. It reuses that sign-in for a request
 * when the sign-in's targets include every requested target, the token is
 * younger than {@link reusableSignInAgeSeconds}, and no requested target has
 * accepted the token yet. Otherwise it signs in again, with a nonce for the
 * requested targets. Without a sign-in method, for a run that must not prompt,
 * it throws `OwnerLoginRequiredError`.
 *
 * Every target must come from a URL that the user gave for the operation, or
 * from one that the CLI derived from it, never from a server's response.
 */
export class BoundSignIn {
	#held: HeldSignIn | undefined;

	constructor(
		private readonly method: SignInMethod | undefined,
		private readonly now: () => number = Date.now
	) {}

	private async presentOnce<T>(
		targets: readonly CanonicalTarget[],
		target: CanonicalTarget,
		exchange: (token: BoundIdToken) => Promise<T>
	): Promise<T> {
		const token = await this.idTokenFor(targets);
		const result = await exchange(token);

		if (this.#held?.token === token) {
			this.#held.presentedAt.add(target);
		}

		return result;
	}

	private isReusable(
		held: HeldSignIn,
		targets: readonly CanonicalTarget[]
	): boolean {
		const { binding } = held.token;
		const issuedAt = held.issuedAtSeconds;

		if (issuedAt === undefined) {
			return false;
		}

		const ageSeconds = this.now() / 1000 - issuedAt;

		return (
			ageSeconds < reusableSignInAgeSeconds &&
			targets.every(
				(target) =>
					binding.targets.includes(target) && !held.presentedAt.has(target)
			)
		);
	}

	async idTokenFor(targets: readonly CanonicalTarget[]): Promise<BoundIdToken> {
		const held = this.#held;

		if (held !== undefined && this.isReusable(held, targets)) {
			return held.token;
		}

		if (this.method === undefined) {
			throw new OwnerLoginRequiredError();
		}

		this.#held = undefined;

		const seed = randomBytes(32).toString('base64url');
		const binding = { seed, targets: [...targets] };
		const nonce = await subjectBindingNonce(binding.targets, seed);
		const idToken = await this.method.signIn(nonce);
		const claims = idTokenClaimsSchema.safeParse(decodeJwtPayload(idToken));

		if (!claims.success || claims.data.nonce !== nonce) {
			throw new NonceNotBoundError();
		}

		const token = { idToken, binding };
		this.#held = {
			token,
			issuedAtSeconds: claims.data.iat,
			presentedAt: new Set()
		};

		return token;
	}

	/**
	 * Runs `exchange`, which sends a token bound to `targets` to `target`. When
	 * the server accepts the token, it is recorded as presented at `target` and
	 * is not given out for `target` again.
	 *
	 * The server refuses a token because of its binding when it has already
	 * accepted the token, when the targets do not include the server's URL, or
	 * when the token is too old. After such a refusal, the held sign-in is
	 * discarded and the exchange runs once more with a new sign-in. When the
	 * server also refuses the new token as unbound, it does not accept `target`
	 * as its own URL, and `present` throws `TargetNotAcceptedError`.
	 * Any other failure, including a request that received no response, keeps
	 * the held sign-in, so a retry can present the same token.
	 */
	async present<T>(
		targets: readonly CanonicalTarget[],
		target: CanonicalTarget,
		exchange: (token: BoundIdToken) => Promise<T>
	): Promise<T> {
		try {
			return await this.presentOnce(targets, target, exchange);
		} catch (error) {
			if (!isBindingRefusal(error)) {
				throw error;
			}
		}

		this.#held = undefined;

		try {
			return await this.presentOnce(targets, target, exchange);
		} catch (error) {
			if (isBindingRefusal(error, subjectBindingProblems.unbound)) {
				throw new TargetNotAcceptedError(target, { cause: error });
			}

			throw error;
		}
	}
}

const bindingRefusals: ReadonlySet<string> = new Set<string>(
	Object.values(subjectBindingProblems)
);

const badRequestStatus: number = StatusCodes.BAD_REQUEST;

/**
 * Whether the server refused a subject token because of its binding, and,
 * with `only`, with that problem.
 */
export function isBindingRefusal(error: unknown, only?: string): boolean {
	if (
		!(error instanceof CupboardHttpError) ||
		error.status !== badRequestStatus ||
		!hasOAuthErrorCode(error, 'invalid_grant')
	) {
		return false;
	}

	const problem = oauthErrorProblem(error);

	return (
		problem !== undefined &&
		bindingRefusals.has(problem) &&
		(only === undefined || problem === only)
	);
}
