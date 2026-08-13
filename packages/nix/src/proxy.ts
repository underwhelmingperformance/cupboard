// The agent is handed to the global `fetch`, which types its dispatcher from
// the `undici-types` that `@types/node` carries, so undici's own version has to
// be the one those types are published from.
import { type Dispatcher, EnvHttpProxyAgent } from 'undici';

/**
 * Proxy values from the environment, using libcurl's names and precedence. A
 * field is absent when no variable configures that proxy.
 */
export interface NamedProxies {
	readonly httpProxy?: string;
	readonly httpsProxy?: string;
	readonly noProxy?: string;
}

/** An environment as this reads one: variable names to their values. */
export type ProxyEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The proxies the environment names. libcurl reads `<scheme>_proxy` first and
 * falls back to `all_proxy`, taking the first non-empty value.
 *
 * `http_proxy` is read in lower case alone. A CGI script runs with the request
 * headers in its environment, so a request carrying a `Proxy:` header would
 * otherwise name the proxy for every transfer that script made.
 */
export function proxiesNamedBy(env: ProxyEnvironment): NamedProxies {
	const httpProxy = firstNamed(env, ['http_proxy', 'all_proxy', 'ALL_PROXY']);
	const httpsProxy = firstNamed(env, [
		'https_proxy',
		'HTTPS_PROXY',
		'all_proxy',
		'ALL_PROXY'
	]);
	const noProxy = firstNamed(env, ['no_proxy', 'NO_PROXY']);

	return {
		...(httpProxy !== undefined && { httpProxy }),
		...(httpsProxy !== undefined && { httpsProxy }),
		...(noProxy !== undefined && { noProxy })
	};
}

// An empty value disables the proxy, which is how a variable is unset for one
// command without being unset for the shell that ran it.
function firstNamed(
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
 * A request's proxy dispatcher. Node accepts this as a request option rather
 * than deriving it from the URL.
 */
type RoutedRequest = RequestInit & { readonly dispatcher?: Dispatcher };

/**
 * Creates a proxy dispatcher from the environment, or returns `undefined` for
 * direct requests.
 *
 * The hosts `no_proxy` names go direct. That list is read by the agent, which
 * accepts a leading dot, a bare domain matched on its label boundaries, an
 * optional port, and `*` for every host.
 */
export function proxiedFetch(env: ProxyEnvironment): typeof fetch | undefined {
	const proxies = proxiesNamedBy(env);

	if (proxies.httpProxy === undefined && proxies.httpsProxy === undefined) {
		return;
	}

	// Reuse one agent and its proxy connections across requests.
	// The agent otherwise falls back to `process.env` for every absent option.
	// State each absence explicitly so an upper-case HTTP_PROXY deliberately
	// excluded above cannot come back when the agent constructs its routes.
	const dispatcher = new EnvHttpProxyAgent({
		httpProxy: proxies.httpProxy ?? '',
		httpsProxy: proxies.httpsProxy ?? '',
		noProxy: proxies.noProxy ?? ''
	});

	return (input, init) => {
		const routed: RoutedRequest = { ...init, dispatcher };

		return fetch(input, routed);
	};
}
