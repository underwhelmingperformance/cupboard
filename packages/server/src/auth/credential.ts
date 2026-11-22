import { accessKeySecretPrefix } from '@cupboard/protocol/access-keys';
import { readTokenPasswordPrefix } from '@cupboard/protocol/read-access';
import {
	parseAuthenticationHeader,
	parseBasicAuthHeader
} from '@cupboard/shared/http';

/**
The credential that a request presents, before verification. A secret with
the access-key prefix is an access key; verification refuses one that is not
well formed.
*/
export type PresentedCredential =
	| { readonly kind: 'access-token'; readonly token: string }
	| { readonly kind: 'access-key'; readonly secret: string };

/**
Reads the credential from `Authorization: Bearer`, or from the password of
`Authorization: Basic`, whose username is ignored. A Basic password is a
credential only when it is an access key or starts with the read-token
prefix; any other password is a static read credential, which its own
verifier checks.
*/
export function presentedCredential(
	request: Request
): PresentedCredential | undefined {
	const bearer = bearerCredential(request);

	if (bearer !== undefined) {
		return bearer;
	}

	const parsed = parseBasicAuthHeader(authorizationOf(request));

	if (!parsed.ok) {
		return undefined;
	}

	const { password } = parsed.credential;

	if (password.startsWith(accessKeySecretPrefix)) {
		return { kind: 'access-key', secret: password };
	}

	return password.startsWith(readTokenPasswordPrefix)
		? {
				kind: 'access-token',
				token: password.slice(readTokenPasswordPrefix.length)
			}
		: undefined;
}

/**
Reads the credential from `Authorization: Bearer` only.
*/
export function bearerCredential(
	request: Request
): PresentedCredential | undefined {
	const value = parseAuthenticationHeader(authorizationOf(request), 'Bearer');

	if (value === undefined) {
		return undefined;
	}

	return value.startsWith(accessKeySecretPrefix)
		? { kind: 'access-key', secret: value }
		: { kind: 'access-token', token: value };
}

function authorizationOf(request: Request): string | undefined {
	return request.headers.get('authorization') ?? undefined;
}
