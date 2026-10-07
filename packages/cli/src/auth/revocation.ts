import { canonicalHref } from '@cupboard/nix-store/url';
import { discardResponseBody } from '@cupboard/shared/cleanup';

import { throwIfAborted } from '../abort.ts';

import { postForm } from './oidc-login.ts';

/**
 * The result of a revocation request for a refresh token. `no-refresh-token`
 * means that the saved sign-in had no refresh token to revoke.
 */
export type RevocationOutcome = 'revoked' | 'failed' | 'no-refresh-token';

/**
 * Sends an RFC 7009 revocation request. A successful response counts as
 * revoked. A network failure, a redirect or an error status reads as
 * `failed`, because the caller deletes its local copy in every case. An
 * aborted signal still throws.
 */
export async function postRevocation(
	endpoint: string,
	form: Readonly<Record<string, string>>,
	fetcher: typeof fetch,
	signal?: AbortSignal
): Promise<RevocationOutcome> {
	let response: Response;

	try {
		response = await fetcher(endpoint, postForm(form, signal));
	} catch {
		throwIfAborted(signal);

		return 'failed';
	}

	await discardResponseBody(response);

	return response.ok ? 'revoked' : 'failed';
}

/**
 * Revokes a cupboard refresh token at the revocation endpoint of the tenant
 * or deployment URL that issued it.
 */
export function revokeRefreshToken(
	target: URL,
	refreshToken: string,
	fetcher: typeof fetch,
	signal?: AbortSignal
): Promise<RevocationOutcome> {
	return postRevocation(
		`${canonicalHref(target)}/revoke`,
		{ token: refreshToken, token_type_hint: 'refresh_token' },
		fetcher,
		signal
	);
}
