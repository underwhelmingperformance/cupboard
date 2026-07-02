import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';
import {
	clearBlobStorage,
	resetTestServer,
	verifiableNar,
	verifiableNarStored
} from '../test-support.ts';

import { promoteVerifiedBlob } from './promote-blob.ts';

// The canonical key is write-once through a conditional put: the first
// promotion of a hash fixes the stored encoding, and a promotion that loses
// the race adopts the winner's encoding so its narinfo describes the object
// actually served. Both the Durable Object and the queue consumer run this,
// so the race branch is shared ground.
describe('promoteVerifiedBlob', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('adopts the winning encoding when it loses the conditional put', async () => {
		const staged = await verifiableNar('promote-loser');
		const winner = await verifiableNarStored('promote-loser');
		const canonicalKey = narObjectKey(staged.narHash);
		const stagingKey = 'staging/promote-loser/upload';

		await env.BLOBS.put(stagingKey, staged.narBytes);

		// The winner's object lands between this promote's head and its put; the
		// head is blinded once so the conditional put is what discovers the race.
		await env.BLOBS.put(canonicalKey, winner.narBytes, {
			sha256: NixSha256Hash.parse(winner.fileHash).digestBytes()
		});

		// Blinding redirects the head to a key that holds nothing, so the miss is
		// a genuine R2 answer rather than a fabricated value.
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		let isBlinded = true;
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key: string) => {
				if (key === canonicalKey && isBlinded) {
					isBlinded = false;

					return originalHead('test/absent');
				}

				return originalHead(key);
			});

		try {
			const blob = await promoteVerifiedBlob(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				env.BLOBS,
				stagingKey,
				{ narHash: staged.narHash, narSize: staged.narSize },
				{ fileHash: staged.fileHash, fileSize: staged.narBytes.byteLength }
			);

			expect(blob).toStrictEqual({
				fileHash: winner.fileHash,
				fileSize: winner.narBytes.byteLength
			});
		} finally {
			head.mockRestore();
		}
	});

	it('throws when the winner vanished before it could be adopted', async () => {
		const staged = await verifiableNar('promote-vanished');
		const canonicalKey = narObjectKey(staged.narHash);
		const stagingKey = 'staging/promote-vanished/upload';

		await env.BLOBS.put(stagingKey, staged.narBytes);

		// The canonical object exists, so the conditional put genuinely loses,
		// but every head answers absent: whatever won reads as gone again, and
		// nothing remains to adopt or to bind a narinfo to.
		await env.BLOBS.put(canonicalKey, staged.narBytes);

		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key: string) =>
				originalHead(key === canonicalKey ? 'test/absent' : key)
			);

		try {
			await expect(
				promoteVerifiedBlob(
					drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
					env.BLOBS,
					stagingKey,
					{ narHash: staged.narHash, narSize: staged.narSize },
					{ fileHash: staged.fileHash, fileSize: staged.narBytes.byteLength }
				)
			).rejects.toBeInstanceOf(UploadedObjectNotFoundError);
		} finally {
			head.mockRestore();
		}
	});
});
