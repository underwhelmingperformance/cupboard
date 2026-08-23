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
	{
		name: 'returns no settings when the environment has no proxy variables',
		env: {},
		expected: {}
	},
	{
		name: "selects each scheme's own proxy",
		env: { http_proxy: proxy, https_proxy: other },
		expected: { httpProxy: proxy, httpsProxy: other }
	},
	{
		name: 'uses all_proxy for both schemes',
		env: { all_proxy: proxy },
		expected: { httpProxy: proxy, httpsProxy: proxy }
	},
	{
		name: 'uses https_proxy ahead of all_proxy',
		env: { all_proxy: other, https_proxy: proxy },
		expected: { httpProxy: other, httpsProxy: proxy }
	},
	{
		name: 'reads ALL_PROXY',
		env: { ALL_PROXY: proxy },
		expected: { httpProxy: proxy, httpsProxy: proxy }
	},
	{
		name: 'reads HTTPS_PROXY',
		env: { HTTPS_PROXY: proxy },
		expected: { httpsProxy: proxy }
	},
	{
		name: 'ignores HTTP_PROXY',
		env: { HTTP_PROXY: proxy },
		expected: {}
	},
	{
		name: 'reads no_proxy',
		env: { http_proxy: proxy, no_proxy: 'cache.example,.internal' },
		expected: { httpProxy: proxy, noProxy: 'cache.example,.internal' }
	},
	{
		name: 'reads NO_PROXY',
		env: { https_proxy: proxy, NO_PROXY: '*' },
		expected: { httpsProxy: proxy, noProxy: '*' }
	},
	{
		name: 'skips an empty http_proxy and falls back to all_proxy',
		env: { http_proxy: '', all_proxy: proxy },
		expected: { httpProxy: proxy, httpsProxy: proxy }
	}
];

describe('proxySettingsFrom', () => {
	it.each(cases)('$name', ({ env, expected }) => {
		expect(proxySettingsFrom(env)).toStrictEqual(expected);
	});
});

describe('proxiedFetch', () => {
	it.each([
		{
			name: 'returns no proxy fetcher when the environment has no proxy',
			env: {},
			routed: false
		},
		{
			name: 'returns no proxy fetcher when the environment only sets no_proxy',
			env: { no_proxy: '*' },
			routed: false
		},
		{
			name: 'creates a proxy fetcher for http_proxy',
			env: { http_proxy: proxy },
			routed: true
		},
		{
			name: 'creates a proxy fetcher for all_proxy',
			env: { all_proxy: proxy },
			routed: true
		}
	])('$name', ({ env, routed }) => {
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
