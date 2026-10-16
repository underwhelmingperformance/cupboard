import { NixConfig } from '@cupboard/nix-store/nix-config';
import { keyRotateResponseSchema } from '@cupboard/protocol/keys';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedWorkerFetch,
	currentOrigin,
	handlerFetch,
	initialiseViaWorker,
	namedCache,
	provisionFixtureTenant,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer
} from '../test-support.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

async function setup(): Promise<string> {
	const token = await initialiseViaWorker();
	await putWorkerTestCache(token, { kind: 'default' });
	await putWorkerTestCache(token, namedCache('builds'));
	return token;
}

describe('cache setup pages', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});

	it.each(['', '/', '/cache/builds', '/cache/builds/'])(
		'serves the current configuration at %s without reflecting query credentials',
		async (path) => {
			await setup();
			const keysResponse = await readFetch('/pubkey');
			const keys = await keysResponse.text();
			const response = await readFetch(`${path}?token=private-credential`);
			const body = await response.text();
			const url = new URL(`/t/${fixtureTenant}${path}`, currentOrigin());
			url.pathname = url.pathname.replace(/\/$/u, '');
			expect({
				status: response.status,
				contentType: response.headers.get('content-type'),
				cacheControl: response.headers.get('cache-control'),
				configuration:
					/<pre><code>(?<configuration>[^<]*)<\/code><\/pre>/u.exec(body)
						?.groups?.configuration,
				reflectsCredential: body.includes('private-credential'),
				listsCacheUrl: body.includes(url.href)
			}).toStrictEqual({
				status: StatusCodes.OK,
				contentType: 'text/html; charset=UTF-8',
				cacheControl: 'no-store',
				configuration: new NixConfig(url, keys).render(),
				reflectsCredential: false,
				listsCacheUrl: true
			});
		}
	);

	it('authenticates private pages and returns an empty HEAD response', async () => {
		const token = await setup();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		await putWorkerTestCache(token, namedCache('builds'), 'private');
		const headers = { authorization: `Basic ${btoa('alice:secret')}` };
		const denied = await readFetch('/cache/builds');
		const allowed = await readFetch('/cache/builds', { headers });
		const head = await readFetch('/cache/builds', { method: 'HEAD', headers });
		expect({
			denied: denied.status,
			allowed: allowed.status,
			head: head.status,
			headBody: await head.text(),
			cacheControl: head.headers.get('cache-control'),
			policy: head.headers.get('content-security-policy')
		}).toStrictEqual({
			denied: StatusCodes.UNAUTHORIZED,
			allowed: StatusCodes.OK,
			head: StatusCodes.OK,
			headBody: '',
			cacheControl: 'no-store',
			policy:
				"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		});
	});

	it('refreshes every published key during rotation', async () => {
		const token = await setup();
		const beforeResponse = await readFetch('/pubkey');
		const before = await beforeResponse.text();
		const rotated = await authorisedWorkerFetch('/keys/rotate', token, {
			method: 'POST'
		});
		const rotation = keyRotateResponseSchema.parse(await rotated.json());
		const keysResponse = await readFetch('/pubkey');
		const keys = await keysResponse.text();
		const pageResponse = await readFetch('/');
		const page = await pageResponse.text();
		expect({
			status: rotated.status,
			keysChanged: keys !== before,
			includesOldKey: page.includes(before.trim()),
			includesNewKey: page.includes(rotation.rotated.key.publicKey)
		}).toStrictEqual({
			status: StatusCodes.OK,
			keysChanged: true,
			includesOldKey: true,
			includesNewKey: true
		});
	});

	it('refuses absent, deleted and non-canonical cache roots', async () => {
		const token = await setup();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		const headers = { authorization: `Basic ${btoa('alice:secret')}` };
		const removed = await authorisedWorkerFetch('/caches/builds', token, {
			method: 'DELETE'
		});
		expect(removed.status).toBe(StatusCodes.OK);
		const responses = await Promise.all([
			readFetch('/cache/builds'),
			readFetch('/cache/missing', { headers }),
			readFetch('/cache/%62uilds'),
			readFetch('/cach%65/builds'),
			handlerFetch('/t/unknown')
		]);
		expect(responses.map((response) => response.status)).toStrictEqual([
			StatusCodes.NOT_FOUND,
			StatusCodes.NOT_FOUND,
			StatusCodes.NOT_FOUND,
			StatusCodes.NOT_FOUND,
			StatusCodes.NOT_FOUND
		]);
	});
});
