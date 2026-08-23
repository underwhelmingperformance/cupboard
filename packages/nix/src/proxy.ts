import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

export interface ProxySettings {
	readonly httpProxy?: string;
	readonly httpsProxy?: string;
	readonly noProxy?: string;
}

export type ProxyEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Reads proxy settings with libcurl's variable names and precedence. For each
 * scheme, it uses the first non-empty scheme-specific variable, then falls back
 * to `all_proxy`.
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

// Treat an empty variable as unset. This leaves later fallback variables
// available, matching libcurl.
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
 *
 * The returned fetcher forwards every request option, including abort and
 * timeout signals, and adds only the proxy dispatcher.
 */
export function proxiedFetch(
	env: ProxyEnvironment
): typeof undiciFetch | undefined {
	const proxies = proxySettingsFrom(env);

	if (proxies.httpProxy === undefined && proxies.httpsProxy === undefined) {
		return;
	}

	// EnvHttpProxyAgent reads process.env for omitted options. Pass an empty string
	// for every unconfigured option so ignored ambient values, including
	// HTTP_PROXY, cannot re-enter the routing decision.
	const dispatcher = new EnvHttpProxyAgent({
		httpProxy: proxies.httpProxy ?? '',
		httpsProxy: proxies.httpsProxy ?? '',
		noProxy: proxies.noProxy ?? ''
	});

	return (input, init) => {
		return undiciFetch(input, { ...init, dispatcher });
	};
}
