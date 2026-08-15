import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type {
	KeyRetireResponse,
	KeyRotateResponse
} from '@cupboard/protocol/keys';
import {
	keyRetireResponseSchema,
	keyRotateResponseSchema
} from '@cupboard/protocol/keys';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	fetchNarInfo,
	fetchPath,
	isNarInfoSignatureValid,
	issueServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

async function rotate(
	token: string
): Promise<{ readonly status: number; readonly body: KeyRotateResponse }> {
	const response = await authorisedFetch('/keys/rotate', token, {
		method: 'POST'
	});

	return {
		status: response.status,
		body: keyRotateResponseSchema.parse(await response.json())
	};
}

async function retire(
	token: string,
	id: string
): Promise<{ readonly status: number; readonly body: KeyRetireResponse }> {
	const response = await authorisedFetch(`/keys/retire/${id}`, token, {
		method: 'POST'
	});

	return {
		status: response.status,
		body: keyRetireResponseSchema.parse(await response.json())
	};
}

async function publishedKeys(): Promise<string[]> {
	const response = await fetchPath('/pubkey');
	const body = await response.text();

	return body.trim().split('\n');
}

describe('signing key rotation', () => {
	beforeEach(resetTestServer);

	it('opens a window where new narinfos dual-sign and old ones are untouched', async () => {
		const init = await bootstrap();
		const before = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'before'
		});
		await pushPath(init.token, before);

		const rotation = await rotate(init.token);
		const { rotated } = rotation.body;

		const after = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'after'
		});
		await pushPath(init.token, after);

		const oldKey = init.publicKey;
		const newKey = rotated.publicKey;
		const beforeNarInfo = await fetchNarInfo(before.storePathHash);
		const afterNarInfo = await fetchNarInfo(after.storePathHash);
		const published = await publishedKeys();

		expect({
			rotationStatus: rotation.status,
			rotatedStage: rotated.stage,
			publishedKeys: published.toSorted(byCodeUnit),
			before: {
				sigs: beforeNarInfo.sigs.length,
				verifiesUnderOld: await isNarInfoSignatureValid(beforeNarInfo, oldKey),
				verifiesUnderNew: await isNarInfoSignatureValid(beforeNarInfo, newKey)
			},
			after: {
				sigs: afterNarInfo.sigs.length,
				verifiesUnderOld: await isNarInfoSignatureValid(afterNarInfo, oldKey),
				verifiesUnderNew: await isNarInfoSignatureValid(afterNarInfo, newKey)
			}
		}).toStrictEqual({
			rotationStatus: StatusCodes.OK,
			rotatedStage: 'signing',
			publishedKeys: [oldKey, newKey].toSorted(byCodeUnit),
			before: { sigs: 1, verifiesUnderOld: true, verifiesUnderNew: false },
			after: { sigs: 2, verifiesUnderOld: true, verifiesUnderNew: true }
		});
	});

	it('retires a key through publication then absent, idempotently', async () => {
		const init = await bootstrap();
		const rotation = await rotate(init.token);
		const { rotated } = rotation.body;

		const first = await retire(init.token, 'active');
		const second = await retire(init.token, 'active');
		const third = await retire(init.token, 'active');

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'c'.repeat(32),
			name: 'after-retire'
		});
		await pushPath(init.token, path);
		const narInfo = await fetchNarInfo(path.storePathHash);
		const published = await publishedKeys();

		expect({
			rotationStatus: rotation.status,
			retireStatuses: [first.status, second.status, third.status],
			stages: [first.body.stage, second.body.stage, third.body.stage],
			publishedKeys: published,
			sigs: narInfo.sigs.length,
			verifiesUnderRetired: await isNarInfoSignatureValid(
				narInfo,
				init.publicKey
			),
			verifiesUnderSurvivor: await isNarInfoSignatureValid(
				narInfo,
				rotated.publicKey
			)
		}).toStrictEqual({
			rotationStatus: StatusCodes.OK,
			retireStatuses: [StatusCodes.OK, StatusCodes.OK, StatusCodes.OK],
			stages: ['publication', 'absent', 'absent'],
			publishedKeys: [rotated.publicKey],
			sigs: 1,
			verifiesUnderRetired: false,
			verifiesUnderSurvivor: true
		});
	});

	it('refuses to retire the only signing key', async () => {
		const init = await bootstrap();

		const response = await authorisedFetch('/keys/retire/active', init.token, {
			method: 'POST'
		});

		expect(response.status).toBe(StatusCodes.CONFLICT);
	});

	it('rejects rotation and retirement without admin scope', async () => {
		await bootstrap();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const rotateResponse = await authorisedFetch('/keys/rotate', writeToken, {
			method: 'POST'
		});
		const retireResponse = await authorisedFetch(
			'/keys/retire/active',
			writeToken,
			{ method: 'POST' }
		);

		expect({
			rotate: rotateResponse.status,
			retire: retireResponse.status
		}).toStrictEqual({
			rotate: StatusCodes.FORBIDDEN,
			retire: StatusCodes.FORBIDDEN
		});
	});
});
