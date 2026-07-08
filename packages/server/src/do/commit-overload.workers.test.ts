import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	initialise,
	negotiateUploads,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

// The D1 overload text the binding injects when it sheds load. Only this test
// file and the detection helper in transient.ts ever reference this text; the
// detection helper is the single location that matches on message text.
const d1OverloadText =
	'D1_ERROR: D1 DB is overloaded. Too many requests queued.';

describe('commit socket overload handling', () => {
	beforeEach(resetTestServer);

	it('answers a commit whose D1 charge batch hits an overload with a 503 error frame', async () => {
		const token = await initialise();
		const path = uploadMetadata({ storePathHash: 'a'.repeat(32), fileSize: 1 });
		const negotiated = await negotiateUploads(token, [path]);
		const decision = negotiated.uploads[0];

		if (decision?.action !== 'upload') {
			throw new Error('expected an upload decision');
		}

		const { uploadId, r2Key } = decision;
		await putNarBytes(r2Key);

		// Make every D1 batch call throw the overload message so the commit
		// pipeline's charge batch faults with the D1 signal.
		const batchSpy = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockRejectedValue(new Error(d1OverloadText));

		try {
			const session = await openCommitSession(token);
			session.send({ op: 'commit', uploadId });
			const frame = await session.nextFrame();
			session.socket.close();

			expect(frame).toStrictEqual({
				ev: 'error',
				uploadId,
				status: StatusCodes.SERVICE_UNAVAILABLE,
				message: 'Database is temporarily overloaded'
			});
		} finally {
			batchSpy.mockRestore();
		}
	});
});
