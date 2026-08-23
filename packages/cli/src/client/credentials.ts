export interface TokenProvider {
	get(): Promise<string>;
	refresh(): Promise<string>;
}

export type AccessCredential = string | TokenProvider;

/**
 * A provider-backed attempt can refresh once after a 401. `headers` combines
 * the bearer token with any transport headers supplied by the caller.
 */
export interface BearerAttempt {
	readonly headers: Readonly<Record<string, string>>;
	/**
	 * After a 401, returns one attempt with a refreshed provider credential.
	 * Returns `undefined` for a fixed credential or after the refresh was used.
	 */
	refreshAfterAuthenticationFailure(): Promise<BearerAttempt | undefined>;
}

/**
 * Creates the authentication attempt for one HTTP request or WebSocket
 * upgrade. Its refresh method handles a 401 on that attempt. After a WebSocket
 * expiry close, the commit session calls its authorisation provider to create a
 * new attempt instead.
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
