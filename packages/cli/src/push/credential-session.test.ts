import { type PushCredential } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { credentialSession } from './credential-session.ts';

function credential(
	overrides: Partial<PushCredential> & { expiresAt: string }
): PushCredential {
	return {
		pushId: 'push-1',
		accessKeyId: 'access',
		secretAccessKey: 'secret',
		sessionToken: 'token',
		endpoint: 'https://acct.r2.cloudflarestorage.com',
		bucket: 'cupboard-blobs',
		...overrides
	};
}

const base = Date.parse('2026-06-30T12:00:00.000Z');
const minutes = (n: number): string =>
	new Date(base + n * 60_000).toISOString();

describe('credentialSession', () => {
	it('issues once and reuses the credential while it is comfortably valid', async () => {
		const issued: (string | undefined)[] = [];
		const session = credentialSession(
			(pushId) => {
				issued.push(pushId);

				return Promise.resolve(credential({ expiresAt: minutes(60) }));
			},
			{ now: () => base }
		);

		const first = await session.provider();
		const second = await session.provider();
		const pushId = await session.pushId();

		expect({ issued, sameInstance: first === second, pushId }).toStrictEqual({
			issued: [undefined],
			sameInstance: true,
			pushId: 'push-1'
		});
	});

	it('re-issues against the same push id once the credential nears expiry', async () => {
		const issued: (string | undefined)[] = [];
		let clock = base;
		const session = credentialSession(
			(pushId) => {
				issued.push(pushId);

				// Each issue lasts ten minutes from the current clock.
				return Promise.resolve(
					credential({
						pushId: 'push-1',
						sessionToken: `token-${String(issued.length)}`,
						expiresAt: new Date(clock + 10 * 60_000).toISOString()
					})
				);
			},
			{ now: () => clock, refreshMarginMs: 5 * 60_000 }
		);

		const before = await session.provider();
		// Advance past the refresh margin: only five minutes of life remain.
		clock = base + 6 * 60_000;
		const after = await session.provider();

		expect({
			issued,
			renewed: before.sessionToken !== after.sessionToken,
			afterToken: after.sessionToken
		}).toStrictEqual({
			issued: [undefined, 'push-1'],
			renewed: true,
			afterToken: 'token-2'
		});
	});

	it('shares one in-flight issue across concurrent callers', async () => {
		let calls = 0;
		let resolveIssue: ((credential: PushCredential) => void) | undefined;
		const issued = new Promise<PushCredential>((resolve) => {
			resolveIssue = resolve;
		});
		const session = credentialSession(
			() => {
				calls += 1;

				return issued;
			},
			{ now: () => base }
		);

		const credentialPromise = session.provider();
		const pushIdPromise = session.pushId();
		resolveIssue?.(credential({ expiresAt: minutes(60) }));

		const resolvedCredential = await credentialPromise;

		expect({
			calls,
			pushId: await pushIdPromise,
			credential: resolvedCredential.pushId
		}).toStrictEqual({ calls: 1, pushId: 'push-1', credential: 'push-1' });
	});
});
