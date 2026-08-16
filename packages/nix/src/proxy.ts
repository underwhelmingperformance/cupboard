import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * Proxy values from the environment, using libcurl's variable names and
 * precedence. A field is absent when no variable configures that proxy.
 */
export interface ProxySettings {
	readonly httpProxy?: string;
	readonly httpsProxy?: string;
	readonly noProxy?: string;
}

/**
An environment as this module reads one: variable names to their values.
*/
export type ProxyEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The proxies the environment configures. libcurl reads `<scheme>_proxy` first
 * and falls back to `all_proxy`, taking the first non-empty value.
 *
 * `http_proxy` is read in lower case alone. A CGI script runs with the request
 * headers in its environment as `HTTP_*` variables, so a request carrying a
 * `Proxy:` header would otherwise choose the proxy for every transfer that
 * script made.
 */
export function proxySettingsFrom(env: ProxyEnvironment): ProxySettings {
	const httpProxy = firstNonEmpty(env, [
		'http_proxy',
		'all_proxy',
		'ALL_PROXY'
	]);
	const httpsProxy = firstNonEmpty(env, [
		'https_proxy',
		'HTTPS_PROXY',
		'all_proxy',
		'ALL_PROXY'
	]);
	const noProxy = firstNonEmpty(env, ['no_proxy', 'NO_PROXY']);

	return {
		...(httpProxy !== undefined && { httpProxy }),
		...(httpsProxy !== undefined && { httpsProxy }),
		...(noProxy !== undefined && { noProxy })
	};
}

// An empty value disables the proxy, which is how a variable is unset for one
// command without being unset for the shell that ran it.
function firstNonEmpty(
	env: ProxyEnvironment,
	names: readonly string[]
): string | undefined {
	for (const name of names) {
		const value = env[name];

		if (value !== undefined && value !== '') {
			return value;
		}
	}

	return undefined;
}

/**
 * Creates a proxy dispatcher from the environment, or returns `undefined` for
 * direct requests.
 *
 * The hosts listed in `no_proxy` go direct. That list is read by the agent,
 * which accepts a leading dot, a bare domain matched on its label boundaries,
 * an optional port, and `*` for every host.
 */
export function proxiedFetch(
	env: ProxyEnvironment
): typeof undiciFetch | undefined {
	const proxies = proxySettingsFrom(env);

	if (proxies.httpProxy === undefined && proxies.httpsProxy === undefined) {
		return;
	}

	// Reuse one agent and its proxy connections across requests.
	// The agent otherwise falls back to `process.env` for every absent option.
	// Pass an empty string for each proxy that is not configured, so an
	// upper-case HTTP_PROXY, which is deliberately not read above, cannot come
	// back when the agent builds its routes.
	const dispatcher = new EnvHttpProxyAgent({
		httpProxy: proxies.httpProxy ?? '',
		httpsProxy: proxies.httpsProxy ?? '',
		noProxy: proxies.noProxy ?? ''
	});

	return (input, init) => {
		return undiciFetch(input, { ...init, dispatcher });
	};
}
