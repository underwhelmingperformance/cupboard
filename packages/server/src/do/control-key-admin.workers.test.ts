import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	controlKeyListResponseSchema,
	controlKeyRotateResponseSchema
} from '@cupboard/protocol/control-keys';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	adminGrants,
	controlFetch,
	issueControlAdminToken,
	issueServerSignedToken,
	resetTestServer
} from '../test-support.ts';

const controlKeySchema = z.object({ kid: z.string() });
const controlJwksSchema = z.object({
	keys: z.array(controlKeySchema)
});

function authed(token: string, method = 'POST'): RequestInit {
	return { method, headers: { authorization: `Bearer ${token}` } };
}

// The kids of the live (non-retired) control keys, from the published JWKS.
async function liveControlKids(): Promise<string[]> {
	const response = await controlFetch('/.well-known/jwks.json');
	const body = controlJwksSchema.parse(await response.json());

	return body.keys.map((key) => key.kid).toSorted(byCodeUnit);
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
		const tenantToken = await issueServerSignedToken(adminGrants());
		const response = await controlFetch(
			'/control/keys/rotate',
			authed(tenantToken)
		);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('rotates to a new key, retires it, and refuses to retire the last live key', async () => {
		const token = await issueControlAdminToken();
		const beforeRotate = await liveControlKids();
		const [firstKid] = z.tuple([z.string()]).parse(beforeRotate);

		const rotateResponse = await controlFetch(
			'/control/keys/rotate',
			authed(token)
		);
		const rotated = controlKeyRotateResponseSchema.parse(
			await rotateResponse.json()
		);
		const afterRotate = await liveControlKids();

		const listResponse = await controlFetch(
			'/control/keys',
			authed(token, 'GET')
		);
		const listed = controlKeyListResponseSchema.parse(
			await listResponse.json()
		);

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
		const issuedAfterManualRetire = await issueControlAdminToken();

		expect({
			beforeRotate,
			rotateStatus: rotateResponse.status,
			rotatedToNewKey: rotated.kid !== firstKid,
			afterRotate,
			listedKeys: listed.keys
				.map((key) => ({
					kid: key.kid,
					retired: key.retired
				}))
				.toSorted((left, right) => left.kid.localeCompare(right.kid)),
			retireSecondStatus: retireSecond.status,
			afterRetire,
			retireLastStatus: retireLast.status,
			issuedAfterManualRetire: issuedAfterManualRetire.length > 0
		}).toStrictEqual({
			beforeRotate: [firstKid],
			rotateStatus: StatusCodes.OK,
			rotatedToNewKey: true,
			afterRotate: [firstKid, rotated.kid].toSorted(byCodeUnit),
			listedKeys: [
				{ kid: firstKid, retired: false },
				{ kid: rotated.kid, retired: false }
			].toSorted((left, right) => left.kid.localeCompare(right.kid)),
			retireSecondStatus: StatusCodes.OK,
			afterRetire: [firstKid],
			retireLastStatus: StatusCodes.CONFLICT,
			issuedAfterManualRetire: true
		});
	});
});
