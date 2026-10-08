import { randomBytes } from 'node:crypto';

import { canonicalHref } from '@cupboard/nix-store/url';
import { subjectBindingNonce } from '@cupboard/protocol/subject-binding';

import { type StubOidcIssuer } from './oidc-issuer.ts';

/**
 * An ID token whose `nonce` claim binds it to one server, and the binding
 * parameters that the token request sends, as the CLI sends them.
 */
export interface BoundSubjectToken {
	readonly token: string;
	readonly form: Readonly<Record<string, string>>;
}

/**
 * Signs `claims` with `issuer`, adding a nonce that binds the token to the
 * server at `target`: the deployment URL for the control plane, or a tenant
 * URL. Each call uses a new random seed, so each token has its own nonce.
 */
export async function signBound(
	issuer: StubOidcIssuer,
	claims: Readonly<Record<string, unknown>>,
	target: URL
): Promise<BoundSubjectToken> {
	const seed = randomBytes(32).toString('base64url');
	const targets = [canonicalHref(target)];
	const nonce = await subjectBindingNonce(targets, seed);

	return {
		token: issuer.sign({ ...claims, nonce }),
		form: {
			cupboard_binding_seed: seed,
			cupboard_binding_targets: JSON.stringify(targets)
		}
	};
}
