import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	controlFetch,
	mintControlAdminToken,
	mintServerSignedToken,
	resetTestServer
} from '../test-support.ts';

function authed(token: string, method = 'POST'): RequestInit {
	return { method, headers: { authorization: `Bearer ${token}` } };
}

// The kids of the live (non-retired) control keys, from the published JWKS.
async function liveControlKids(): Promise<string[]> {
	const response = await controlFetch('/.well-known/jwks.json');
	const body = await response.json<{ keys: { kid: string }[] }>();

	return body.keys.map((key) => key.kid).toSorted();
}

describe('control key administration', () => {
	beforeEach(resetTestServer);

	it('rejects an unauthenticated rotate', async () => {
		const response = await controlFetch('/control/keys/rotate', {
			method: 'POST'
		});

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('rejects a tenant token at the control surface', async () => {
		// A tenant admin token is signed by a tenant key, with the tenant issuer and
		// audience; it must not verify against the control key set.
		const tenantToken = await mintServerSignedToken('admin');
		const response = await controlFetch(
			'/control/keys/rotate',
			authed(tenantToken)
		);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('rotates to a new key, retires it, and refuses to retire the last live key', async () => {
		const token = await mintControlAdminToken();
		const beforeRotate = await liveControlKids();
		const firstKid = beforeRotate[0] ?? '';

		const rotateResponse = await controlFetch(
			'/control/keys/rotate',
			authed(token)
		);
		const rotated = await rotateResponse.json<{ kid: string }>();
		const afterRotate = await liveControlKids();

		const listResponse = await controlFetch(
			'/control/keys',
			authed(token, 'GET')
		);
		const listed = await listResponse.json<{
			keys: { kid: string; retired: boolean }[];
		}>();

		const retireSecond = await controlFetch(
			`/control/keys/retire/${rotated.kid}`,
			authed(token)
		);
		const afterRetire = await liveControlKids();

		// The token is signed by the first key, which is still live, so this call
		// authenticates — and is refused only because it would retire the last key.
		const retireLast = await controlFetch(
			`/control/keys/retire/${firstKid}`,
			authed(token)
		);
		const mintedAfterManualRetire = await mintControlAdminToken();

		expect({
			beforeRotateCount: beforeRotate.length,
			rotateStatus: rotateResponse.status,
			rotatedToNewKey: rotated.kid !== firstKid,
			afterRotate: afterRotate.length,
			listedCount: listed.keys.length,
			listedAllLive: listed.keys.every((key) => !key.retired),
			retireSecondStatus: retireSecond.status,
			afterRetire,
			retireLastStatus: retireLast.status,
			mintedAfterManualRetire: mintedAfterManualRetire.length > 0
		}).toStrictEqual({
			beforeRotateCount: 1,
			rotateStatus: StatusCodes.OK,
			rotatedToNewKey: true,
			afterRotate: 2,
			listedCount: 2,
			listedAllLive: true,
			retireSecondStatus: StatusCodes.OK,
			afterRetire: [firstKid],
			retireLastStatus: StatusCodes.CONFLICT,
			mintedAfterManualRetire: true
		});
	});
});
