import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import type { CheckReport } from '@cupboard/protocol/reports';
import { checkReportSchema } from '@cupboard/protocol/reports';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	cacheWriteGrants,
	corruptCommittedNarInfo,
	initialise,
	issueServerSignedToken,
	narBytes,
	narHash,
	pushPath,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	verifiablePath
} from '../test-support.ts';

async function runCheck(token: string, isDeep = false): Promise<CheckReport> {
	const response = await authorisedFetch(
		isDeep ? '/check?deep=true' : '/check',
		token
	);

	expect(response.status).toBe(StatusCodes.OK);

	return checkReportSchema.parse(await response.json());
}

describe('storage check', () => {
	beforeEach(resetTestServer);

	it.each([{ deep: false }, { deep: true }])(
		'reports no discrepancies for a healthy cache (deep: $deep)',
		async ({ deep }) => {
			const token = await initialise();
			const { metadata: alpha, nar: alphaNar } = await verifiablePath('alpha', {
				storePathHash: 'a'.repeat(32),
				name: 'alpha'
			});
			const { metadata: beta, nar: betaNar } = await verifiablePath('beta', {
				storePathHash: 'b'.repeat(32),
				name: 'beta'
			});

			await pushPath(token, alpha, DEFAULT_CACHE, alphaNar);
			await pushPath(token, beta, DEFAULT_CACHE, betaNar);

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
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

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

	it('catches a corrupted NAR blob via its compressed hash only on a deep check', async () => {
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

	it('catches a stored NAR that decompresses to a different hash on a deep check', async () => {
		const token = await initialise();
		const claimed = await verifiableNar('claimed-but-not-stored');
		const { metadata, nar } = await verifiablePath('stored', {
			storePathHash: 'c'.repeat(32),
			name: 'stored'
		});

		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		// Place the genuine bytes under the claimed hash's key (their compressed
		// metadata still matches the narinfo, but they decompress to `nar`, not
		// `claimed`), and repoint the narinfo at that key.
		await env.BLOBS.put(narObjectKey(claimed.narHash), nar.narBytes, {
			sha256: await crypto.subtle.digest('SHA-256', nar.narBytes)
		});
		await corruptCommittedNarInfo(metadata.storePathHash, {
			narHash: claimed.narHash
		});

		const report = await runCheck(token, true);

		expect(report.discrepancies).toStrictEqual([
			{
				kind: 'nar-hash-mismatch',
				cache: '',
				storePathHash: metadata.storePathHash,
				narHash: claimed.narHash
			}
		]);
	});

	it('catches a stored NAR that decompresses to a different size on a deep check', async () => {
		const token = await initialise();
		const { metadata, nar } = await verifiablePath('sized', {
			storePathHash: 'd'.repeat(32),
			name: 'sized'
		});

		await pushPath(token, metadata, DEFAULT_CACHE, nar);
		await corruptCommittedNarInfo(metadata.storePathHash, {
			narSize: nar.narSize + 4096
		});

		const report = await runCheck(token, true);

		expect(report.discrepancies).toStrictEqual([
			{
				kind: 'nar-size-mismatch',
				cache: '',
				storePathHash: metadata.storePathHash,
				narHash: nar.narHash
			}
		]);
	});

	it('requires admin scope', async () => {
		await initialise();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const response = await authorisedFetch('/check', writeToken);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});
});
