import type { CheckReport } from '@cupboard/shared';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfoObjectKey, narObjectKey } from './http.ts';
import {
	authorisedFetch,
	initialise,
	mintServerSignedToken,
	narBytes,
	narHash,
	nixSha256Hash,
	pushPath,
	resetTestServer,
	uploadMetadata
} from './test-support.ts';

async function runCheck(token: string, deep = false): Promise<CheckReport> {
	const response = await authorisedFetch(
		deep ? '/check?deep=true' : '/check',
		token
	);

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<CheckReport>();
}

describe('storage check', () => {
	beforeEach(resetTestServer);

	it.each([{ deep: false }, { deep: true }])(
		'reports no discrepancies for a healthy cache (deep: $deep)',
		async ({ deep }) => {
			const token = await initialise();
			const alpha = uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: 'a'.repeat(32),
				name: 'alpha',
				narHash: nixSha256Hash('a')
			});
			const beta = uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: 'b'.repeat(32),
				name: 'beta',
				narHash: nixSha256Hash('b')
			});

			await pushPath(token, alpha);
			await pushPath(token, beta);

			expect(await runCheck(token, deep)).toStrictEqual({
				narInfosChecked: 2,
				narBlobsChecked: 2,
				complete: true,
				discrepancies: []
			});
		}
	);

	it('flags a narinfo whose R2 object has gone missing', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);
		await env.BLOBS.delete(narInfoObjectKey(metadata.storePathHash));

		expect(await runCheck(token)).toStrictEqual({
			narInfosChecked: 1,
			narBlobsChecked: 1,
			complete: true,
			discrepancies: [
				{
					kind: 'missing-narinfo-object',
					cache: '',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
	});

	it('reports a missing NAR once per narinfo that shares it', async () => {
		const token = await initialise();
		const alpha = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'alpha'
		});
		const beta = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'beta'
		});

		await pushPath(token, alpha);
		await pushPath(token, beta);
		await env.BLOBS.delete(narObjectKey(narHash));

		expect(await runCheck(token)).toStrictEqual({
			narInfosChecked: 2,
			narBlobsChecked: 1,
			complete: true,
			discrepancies: [
				{
					kind: 'missing-nar',
					cache: '',
					storePathHash: alpha.storePathHash,
					narHash
				},
				{
					kind: 'missing-nar',
					cache: '',
					storePathHash: beta.storePathHash,
					narHash
				}
			]
		});
	});

	it('catches a stored NAR whose hash no longer matches only on a deep check', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(token, metadata);

		const tampered = new Uint8Array([9, 9, 9, 9]);
		await env.BLOBS.put(narObjectKey(metadata.narHash), tampered, {
			sha256: await crypto.subtle.digest('SHA-256', tampered)
		});

		expect({
			shallow: await runCheck(token),
			deep: await runCheck(token, true)
		}).toStrictEqual({
			shallow: {
				narInfosChecked: 1,
				narBlobsChecked: 1,
				complete: true,
				discrepancies: []
			},
			deep: {
				narInfosChecked: 1,
				narBlobsChecked: 1,
				complete: true,
				discrepancies: [
					{
						kind: 'file-hash-mismatch',
						cache: '',
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash
					}
				]
			}
		});
	});

	it('requires admin scope', async () => {
		await initialise();
		const writeToken = await mintServerSignedToken('write');

		const response = await authorisedFetch('/check', writeToken);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});
});
