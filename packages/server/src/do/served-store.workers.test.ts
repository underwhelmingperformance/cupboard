import { servedStoreDirectory } from '@cupboard/nix-store/cache-info';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
	initialise,
	narBytes,
	pushPath,
	resetTestServer,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
const served = metadata.storePath;
const hash = metadata.storePathHash;

// A path this cache could never serve: the same basename, a different store.
const foreignStores = [
	{ name: 'a home directory store', directory: '/home/laney/nixstore' },
	{ name: 'a deeply nested store', directory: '/var/lib/cupboard/nix/store' }
];

function foreignPath(directory: string): string {
	return `${directory}/${hash}-first`;
}

function jsonPost(
	pathname: string,
	token: string,
	body: unknown
): Promise<Response> {
	return authorisedFetch(pathname, token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});
}

function jsonPut(
	pathname: string,
	token: string,
	body: unknown
): Promise<Response> {
	return authorisedFetch(pathname, token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});
}

function negotiateBody(storePath: string): unknown {
	return {
		pushId: testPushId,
		paths: [{ ...uploadPathNegotiation(metadata), storePath }]
	};
}

describe('paths from another store directory', () => {
	beforeEach(resetTestServer);

	it('accepts a negotiate and a preview naming a path in the served store', async () => {
		const token = await initialise();

		const negotiate = await jsonPost('/uploads', token, negotiateBody(served));
		const preview = await jsonPost('/uploads/preview', token, {
			paths: [uploadPathNegotiation(metadata)]
		});

		expect({
			servedStore: served.startsWith(`${servedStoreDirectory}/`),
			negotiate: negotiate.status,
			preview: preview.status
		}).toStrictEqual({
			servedStore: true,
			negotiate: StatusCodes.OK,
			preview: StatusCodes.OK
		});
	});

	it.each(foreignStores)(
		'refuses a negotiate and a preview naming a path in $name',
		async ({ directory }) => {
			const token = await initialise();
			const storePath = foreignPath(directory);

			const negotiate = await jsonPost(
				'/uploads',
				token,
				negotiateBody(storePath)
			);
			const preview = await jsonPost('/uploads/preview', token, {
				paths: [{ ...uploadPathNegotiation(metadata), storePath }]
			});

			expect({
				negotiate: negotiate.status,
				preview: preview.status
			}).toStrictEqual({
				negotiate: StatusCodes.BAD_REQUEST,
				preview: StatusCodes.BAD_REQUEST
			});
		}
	);

	it.each(foreignStores)(
		'refuses setting and ensuring a root over a target in $name',
		async ({ directory }) => {
			const token = await initialise();
			await pushPath(token, metadata);
			const targets = [foreignPath(directory)];

			const set = await jsonPut('/roots/ci', token, { targets });
			const ensure = await jsonPost('/roots/ci/ensure', token, {
				targets
			});

			expect({ set: set.status, ensure: ensure.status }).toStrictEqual({
				set: StatusCodes.BAD_REQUEST,
				ensure: StatusCodes.BAD_REQUEST
			});
		}
	);

	it('still sets a root over a target in the served store', async () => {
		const token = await initialise();
		await pushPath(token, metadata);

		const set = await jsonPut('/roots/ci', token, {
			targets: [served]
		});

		expect(set.status).toBe(StatusCodes.OK);
	});
});
