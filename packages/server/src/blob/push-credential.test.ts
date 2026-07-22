import { pushIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import type { R2PresignerConfiguration } from './presign.ts';
import {
	PushCredentialIssuer,
	pushCredentialTtlSeconds
} from './push-credential.ts';
import { pushIdSigningKeySchema } from './push-id.ts';

const now = new Date('2026-06-29T12:00:00.000Z');
const maxTtlSeconds = 6 * 60 * 60;

const configuration: R2PresignerConfiguration = {
	accountId: 'acct-123',
	accessKeyId: 'parent-access-key',
	secretAccessKey: 'parent-secret',
	bucketName: 'cupboard-blobs'
};

function jwtPayload(sessionToken: string): unknown {
	const jwt = atob(sessionToken).slice('jwt/'.length);
	const [, payload = ''] = jwt.split('.', 2);
	const padded = payload
		.replaceAll('-', '+')
		.replaceAll('_', '/')
		.padEnd(Math.ceil(payload.length / 4) * 4, '=');
	const bytes = Uint8Array.from(
		atob(padded),
		(character) => character.codePointAt(0) ?? 0
	);

	return JSON.parse(new TextDecoder().decode(bytes));
}

describe('pushCredentialTtlSeconds', () => {
	it('caps the credential at what the access token has left', () => {
		const tokenExpiresAt = new Date(now.getTime() + 600 * 1000);

		expect(pushCredentialTtlSeconds(tokenExpiresAt, now)).toBe(600);
	});

	it('falls back to the maximum when the token outlives it', () => {
		const tokenExpiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

		expect(pushCredentialTtlSeconds(tokenExpiresAt, now)).toBe(maxTtlSeconds);
	});

	it('floors at one second for an all-but-expired token', () => {
		const tokenExpiresAt = new Date(now.getTime() - 1000);

		expect(pushCredentialTtlSeconds(tokenExpiresAt, now)).toBe(1);
	});
});

describe('PushCredentialIssuer', () => {
	const issuer = new PushCredentialIssuer(
		() => configuration,
		pushIdSigningKeySchema.parse('signing-key')
	);
	const ttlSeconds = 900;
	const issuedAt = Math.floor(now.getTime() / 1000);

	it('grants the write-only actions and no scope, under the staging prefix', async () => {
		// R2 rejects a credential carrying both a scope and an actions claim, so
		// the push grants by the write-only action set alone and confines it with
		// the staging prefix.
		const credential = await issuer.issueFor(
			pushIdSchema.parse('push-1'),
			ttlSeconds,
			now
		);

		expect(jwtPayload(credential.sessionToken)).toStrictEqual({
			bucket: 'cupboard-blobs',
			actions: [
				'PutObject',
				'CreateMultipartUpload',
				'UploadPart',
				'CompleteMultipartUpload',
				'AbortMultipartUpload'
			],
			paths: { prefixPaths: ['staging/push-1/'], objectPaths: [] },
			sub: 'acct-123',
			iss: 'parent-access-key',
			aud: 'acct-123.r2.cloudflarestorage.com',
			iat: issuedAt,
			exp: issuedAt + ttlSeconds
		});
	});
});
