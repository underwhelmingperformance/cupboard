import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
	initialise,
	mintServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

const targetMetadata = uploadMetadata({ fileSize: narBytes.byteLength });
const target = targetMetadata.storePath;

function putRoot(token: string, name: string): Promise<Response> {
	return authorisedFetch(
		`/cache/_default/roots/${encodeURIComponent(name)}`,
		token,
		{
			body: JSON.stringify({ targets: [target] }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);
}

describe('cb_roots enforcement at PUT /roots', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			name: 'a root beneath a permitted prefix',
			cbRoots: ['github:owner/'],
			root: 'github:owner/repo'
		},
		{
			name: 'a root equal to a permitted prefix',
			cbRoots: ['github:owner/'],
			root: 'github:owner/'
		},
		{
			name: 'a root equal to an exact permitted name',
			cbRoots: ['github:owner/repo'],
			root: 'github:owner/repo'
		}
	])('lets a write token set $name', async ({ cbRoots, root }) => {
		const admin = await initialise();
		// Activation gates on servability, so the target must be committed first.
		await pushPath(admin, targetMetadata);
		const token = await mintServerSignedToken('write', 'ci', cbRoots);

		const response = await putRoot(token, root);

		expect(response.status).toBe(StatusCodes.OK);
	});

	it.each([
		{
			name: 'a root outside its permitted prefix',
			cbRoots: ['github:owner/'],
			root: 'github:other/repo'
		},
		{
			name: 'a sibling of an exact permitted name',
			cbRoots: ['github:owner/repo'],
			root: 'github:owner/repo2'
		},
		{
			name: 'a prefix not delimited by a trailing slash',
			cbRoots: ['github:owner'],
			root: 'github:owner-evil/repo'
		},
		{
			name: 'any root when the write token carries no cb_roots',
			cbRoots: undefined,
			root: 'github:owner/repo'
		},
		{
			name: 'any root when the write token carries an empty cb_roots',
			cbRoots: [],
			root: 'github:owner/repo'
		}
	])('refuses a write token $name', async ({ cbRoots, root }) => {
		await initialise();
		const token = await mintServerSignedToken('write', 'ci', cbRoots);

		const response = await putRoot(token, root);
		const body = await response.json<{ code: string; message: string }>();

		expect({
			status: response.status,
			code: body.code,
			message: body.message
		}).toStrictEqual({
			status: StatusCodes.FORBIDDEN,
			code: 'FORBIDDEN',
			message: 'Token is not permitted to set this root'
		});
	});

	it('lets an admin token set any root', async () => {
		const admin = await initialise();
		await pushPath(admin, targetMetadata);
		const token = await mintServerSignedToken('admin', 'owner');

		const response = await putRoot(token, 'github:anything/at-all');

		expect(response.status).toBe(StatusCodes.OK);
	});
});
