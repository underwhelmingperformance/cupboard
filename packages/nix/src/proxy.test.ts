import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ agentOptions: [] as unknown[] }));

vi.mock('undici', () => ({
	EnvHttpProxyAgent: function MockEnvHttpProxyAgent(options: unknown) {
		mocked.agentOptions.push(options);
	}
}));

import { type NamedProxies, proxiedFetch, proxiesNamedBy } from './proxy.ts';

interface ProxyCase {
	readonly name: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly expected: NamedProxies;
}

const proxy = 'http://proxy.example:3128';
const other = 'http://other.example:3128';

const cases: readonly ProxyCase[] = [
	{ name: 'an environment naming none', env: {}, expected: {} },
	{
		name: 'a proxy for each scheme',
		env: { http_proxy: proxy, https_proxy: other },
		expected: { httpProxy: proxy, httpsProxy: other }
	},
	{
		name: 'one proxy for everything',
		env: { all_proxy: proxy },
		expected: { httpProxy: proxy, httpsProxy: proxy }
	},
	{
		name: 'a scheme of its own over the one for everything',
		env: { all_proxy: other, https_proxy: proxy },
		expected: { httpProxy: other, httpsProxy: proxy }
	},
	{
		name: 'the upper-case spelling of the one for everything',
		env: { ALL_PROXY: proxy },
		expected: { httpProxy: proxy, httpsProxy: proxy }
	},
	{
		name: 'the upper-case spelling for https',
		env: { HTTPS_PROXY: proxy },
		expected: { httpsProxy: proxy }
	},
	{
		// A CGI script runs with the request headers in its environment, so a
		// request carrying a `Proxy:` header would name the proxy for every
		// transfer that script made.
		name: 'the upper-case spelling for http, which names nothing',
		env: { HTTP_PROXY: proxy },
		expected: {}
	},
	{
		name: 'the hosts that go direct',
		env: { http_proxy: proxy, no_proxy: 'cache.example,.internal' },
		expected: { httpProxy: proxy, noProxy: 'cache.example,.internal' }
	},
	{
		name: 'the upper-case spelling of the hosts that go direct',
		env: { https_proxy: proxy, NO_PROXY: '*' },
		expected: { httpsProxy: proxy, noProxy: '*' }
	},
	{
		// A variable set to nothing is how one is unset for a single command,
		// so it names no proxy and the next spelling is read instead.
		name: 'an empty value, over which the one for everything is read',
		env: { http_proxy: '', all_proxy: proxy },
		expected: { httpProxy: proxy, httpsProxy: proxy }
	}
];

describe('proxiesNamedBy', () => {
	it.each(cases)('reads $name', ({ env, expected }) => {
		expect(proxiesNamedBy(env)).toStrictEqual(expected);
	});
});

describe('proxiedFetch', () => {
	beforeEach(() => {
		mocked.agentOptions.length = 0;
	});

	// Nothing stands between the request and the network when no variable names
	// a proxy, so the request takes the route every other one takes.
	it.each([
		{ name: 'an environment naming no proxy', env: {}, routed: false },
		{
			name: 'an environment naming only the hosts that go direct',
			env: { no_proxy: '*' },
			routed: false
		},
		{
			name: 'an environment naming a proxy',
			env: { http_proxy: proxy },
			routed: true
		},
		{
			name: 'an environment naming one for everything',
			env: { all_proxy: proxy },
			routed: true
		}
	])('routes $name through a proxy: $routed', ({ env, routed }) => {
		expect(proxiedFetch(env) !== undefined).toBe(routed);
	});

	it('overrides an excluded upper-case HTTP proxy with no proxy', () => {
		proxiedFetch({ HTTP_PROXY: proxy, https_proxy: other });

		expect(mocked.agentOptions).toStrictEqual([
			{ httpProxy: '', httpsProxy: other, noProxy: '' }
		]);
	});
});
