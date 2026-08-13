// The agent is handed to the global `fetch`, which types its dispatcher from
// the `undici-types` that `@types/node` carries, so undici's own version has to
// be the one those types are published from.
import { type Dispatcher, EnvHttpProxyAgent } from 'undici';

/**
 * The proxies an environment names, in the spellings and the order libcurl
 * reads them. A field is absent when nothing names a proxy for it.
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
 * falls back to `all_proxy`, taking the first of them that names anything.
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

// An empty value names nothing, which is how a variable is unset for one
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
 * A request's route through a proxy, which the runtime takes from the request
 * rather than from the URL. Only Node names one, so the option is stated where
 * it is passed rather than read off the shape a request is made from.
 */
type RoutedRequest = RequestInit & { readonly dispatcher?: Dispatcher };

/**
 * How a request is made when the environment names a proxy, or nothing when it
 * names none and requests take the plain route.
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

	// One agent holds the connections to the proxy, so every request this run
	// makes through it shares them.
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
