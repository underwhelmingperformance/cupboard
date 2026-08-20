/**
 * Supplies bearer tokens to the client and can refresh them. The CLI obtains a
 * short-lived access token by OIDC token-exchange and caches it; a long push can
 * outlive that token. Each transport can obtain the current token from the
 * provider and refresh it after an authentication failure.
 */
export interface TokenProvider {
	get(): Promise<string>;
	refresh(): Promise<string>;
}

/**
Either a fixed bearer token or a provider that can refresh one.
*/
export type AccessCredential = string | TokenProvider;

/**
 * The headers and optional refresh for one authenticated transport attempt.
 */
export interface BearerAttempt {
	readonly headers: Readonly<Record<string, string>>;
	/**
	 * Refreshes a provider-backed credential once. Returns `undefined` for a
	 * fixed credential or after the attempt has already refreshed it.
	 */
	refreshAfterAuthenticationFailure(): Promise<BearerAttempt | undefined>;
}

/**
 * Resolves a bearer credential for one HTTP request or WebSocket upgrade.
 * The caller can refresh a provider-backed credential once if the server
 * returns 401 or closes a WebSocket because the token expired.
 */
export async function bearerAttempt(
	credential: AccessCredential | undefined,
	additionalHeaders: Readonly<Record<string, string>> = {}
): Promise<BearerAttempt> {
	const bearer =
		typeof credential === 'object' ? await credential.get() : credential;
	let canRefresh = typeof credential === 'object';

	return {
		headers: withBearer(additionalHeaders, bearer),
		async refreshAfterAuthenticationFailure() {
			if (!canRefresh || typeof credential !== 'object') {
				return;
			}

			canRefresh = false;

			return {
				headers: withBearer(additionalHeaders, await credential.refresh()),
				refreshAfterAuthenticationFailure: () => Promise.resolve(undefined)
			};
		}
	};
}

function withBearer(
	additionalHeaders: Readonly<Record<string, string>>,
	bearer: string | undefined
): Readonly<Record<string, string>> {
	if (bearer === undefined) {
		return additionalHeaders;
	}

	return { ...additionalHeaders, authorization: `Bearer ${bearer}` };
}
