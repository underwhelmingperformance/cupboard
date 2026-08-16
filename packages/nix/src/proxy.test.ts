import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	proxiedFetch,
	type ProxyEnvironment,
	type ProxySettings,
	proxySettingsFrom
} from './proxy.ts';

interface ProxyCase {
	readonly name: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly expected: ProxySettings;
}

const proxy = 'http://proxy.example:3128';
const other = 'http://other.example:3128';

const cases: readonly ProxyCase[] = [
	{ name: 'an environment with no proxy variables', env: {}, expected: {} },
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
		// request carrying a `Proxy:` header would choose the proxy for every
		// transfer that script made.
		name: 'the upper-case spelling for http, which is ignored',
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
		// so it configures no proxy and the next spelling is read instead.
		name: 'an empty value, over which the one for everything is read',
		env: { http_proxy: '', all_proxy: proxy },
		expected: { httpProxy: proxy, httpsProxy: proxy }
	}
];

describe('proxySettingsFrom', () => {
	it.each(cases)('reads $name', ({ env, expected }) => {
		expect(proxySettingsFrom(env)).toStrictEqual(expected);
	});
});

describe('proxiedFetch', () => {
	// Nothing stands between the request and the network when no variable
	// configures a proxy, so the request takes the route every other one takes.
	it.each([
		{ name: 'an environment with no proxy', env: {}, routed: false },
		{
			name: 'an environment with only the hosts that go direct',
			env: { no_proxy: '*' },
			routed: false
		},
		{
			name: 'an environment with a proxy',
			env: { http_proxy: proxy },
			routed: true
		},
		{
			name: 'an environment with one proxy for everything',
			env: { all_proxy: proxy },
			routed: true
		}
	])('routes $name through a proxy: $routed', ({ env, routed }) => {
		expect(proxiedFetch(env) !== undefined).toBe(routed);
	});

	it('sends an HTTP request through the configured proxy', async () => {
		const requests: string[] = [];
		const server = createServer((request, response) => {
			requests.push(request.url ?? '');
			response.statusCode = StatusCodes.ACCEPTED;
			response.setHeader('connection', 'close');
			response.end('from proxy');
		});
		const proxyOrigin = await listen(server);

		try {
			const fetcher = proxiedFetch({ http_proxy: proxyOrigin });

			if (fetcher === undefined) {
				throw new Error('The configured HTTP proxy did not create a fetcher');
			}

			const response = await fetcher(
				new URL('http://cache.invalid/nix-cache-info')
			);

			expect({ requests, status: response.status }).toStrictEqual({
				requests: ['http://cache.invalid/nix-cache-info'],
				status: StatusCodes.ACCEPTED
			});
		} finally {
			await close(server);
		}
	});

	it('bypasses the proxy when no_proxy matches the request host', async () => {
		await expectDirectRequest((proxyOrigin) => ({
			http_proxy: proxyOrigin,
			no_proxy: '127.0.0.1'
		}));
	});

	it('ignores an upper-case HTTP_PROXY value for HTTP requests', async () => {
		await expectDirectRequest((proxyOrigin) => ({
			HTTP_PROXY: proxyOrigin,
			https_proxy: proxyOrigin
		}));
	});
});

async function expectDirectRequest(
	environmentFor: (proxyOrigin: string) => ProxyEnvironment
): Promise<void> {
	const directRequests: string[] = [];
	const direct = createServer((request, response) => {
		directRequests.push(request.url ?? '');
		response.setHeader('connection', 'close');
		response.end('direct');
	});
	const directOrigin = await listen(direct);
	const proxyRequests: string[] = [];
	const proxyServer = createServer((request, response) => {
		proxyRequests.push(request.url ?? '');
		response.statusCode = StatusCodes.BAD_GATEWAY;
		response.setHeader('connection', 'close');
		response.end('from proxy');
	});
	const proxyOrigin = await listen(proxyServer);

	try {
		const fetcher = proxiedFetch(environmentFor(proxyOrigin));

		if (fetcher === undefined) {
			throw new Error('The proxy settings did not create an HTTP fetcher');
		}

		const response = await fetcher(new URL('/nix-cache-info', directOrigin));

		expect({
			directRequests,
			proxyRequests,
			status: response.status
		}).toStrictEqual({
			directRequests: ['/nix-cache-info'],
			proxyRequests: [],
			status: StatusCodes.OK
		});
	} finally {
		await Promise.all([close(direct), close(proxyServer)]);
	}
}

async function listen(server: Server): Promise<string> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');

	const address = server.address();

	if (address === null || typeof address === 'string') {
		throw new Error('The HTTP test server did not listen on a TCP port');
	}

	return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server): Promise<void> {
	server.close();
	await once(server, 'close');
}
