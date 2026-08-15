import { signingKeyIdSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	bootstrap,
	commitUpload,
	expectSingleUploadDecision,
	fetchNarInfo,
	fetchPath,
	isNarInfoSignatureValid,
	narBytes,
	negotiateUploads,
	putNarBytes,
	resetTestServer,
	seedSigningKeys,
	uploadMetadata
} from '../test-support.ts';

function namedBytesName(value: string): string {
	const [name] = z
		.tuple([z.string().min(1), z.string()])
		.parse(value.split(':'));

	return name;
}

describe('signing with a key set', () => {
	beforeEach(resetTestServer);

	it('signs every new narinfo with all signing keys and publishes them', async () => {
		const seeded = await seedSigningKeys([
			{
				id: signingKeyIdSchema.parse('active'),
				name: 'cupboard-1',
				signing: true,
				published: true
			},
			{
				id: signingKeyIdSchema.parse('123e4567-e89b-12d3-a456-426614174000'),
				name: 'cupboard-2',
				signing: true,
				published: true
			}
		]);
		const publishedText = seeded
			.map((key) => key.publicKey)
			.toSorted(byCodeUnit)
			.join('\n');

		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(init.token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key);
		await commitUpload(init.token, upload.uploadId);

		const narInfo = await fetchNarInfo(metadata.storePathHash);
		const sigNames = narInfo.sigs
			.map((sig) => namedBytesName(sig))
			.toSorted(byCodeUnit);
		const verifiesUnderEachKey = await Promise.all(
			seeded.map((key) => isNarInfoSignatureValid(narInfo, key.publicKey))
		);
		const pubkey = await fetchPath('/pubkey');

		expect({
			bootstrapPublicKey: init.publicKey,
			pubkeyBody: await pubkey.text(),
			sigNames,
			verifiesUnderEachKey
		}).toStrictEqual({
			bootstrapPublicKey: publishedText,
			pubkeyBody: `${publishedText}\n`,
			sigNames: ['cupboard-1', 'cupboard-2'],
			verifiesUnderEachKey: [true, true]
		});
	});
});
