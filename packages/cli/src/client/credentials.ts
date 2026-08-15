/**
 * Supplies bearer tokens to the client and can refresh them. The CLI obtains a
 * short-lived access token by OIDC token-exchange and caches it; a long push can
 * outlive that token, so the client refreshes through the provider and retries
 * once on a 401.
 */
export interface TokenProvider {
	get(): Promise<string>;
	refresh(): Promise<string>;
}

/**
Either a fixed bearer token or a provider that can refresh one.
*/
export type AccessCredential = string | TokenProvider;

export function isTokenProvider(
	credential: AccessCredential | undefined
): credential is TokenProvider {
	return typeof credential === 'object';
}

export async function resolveBearer(
	credential: AccessCredential | undefined
): Promise<string | undefined> {
	if (credential === undefined || typeof credential === 'string') {
		return credential;
	}

	return credential.get();
}

export function bearerHeaders(
	bearer: string | undefined
): Readonly<Record<string, string>> {
	return bearer === undefined ? {} : { authorization: `Bearer ${bearer}` };
}
