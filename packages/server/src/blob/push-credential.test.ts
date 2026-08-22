import { tenantIdSchema, ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import { pushIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { InvalidPushIdError } from '../errors.ts';

import type { R2PresignerConfiguration } from './presign.ts';
import {
	PushCredentialIssuer,
	pushCredentialTtlSeconds
} from './push-credential.ts';
import { pushIdSigningKeySchema } from './push-id.ts';

const now = new Date('2026-06-29T12:00:00.000Z');
const maxTtlSeconds = ttlSecondsSchema.parse(6 * 60 * 60);

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
	it("uses the access token's remaining whole seconds", () => {
		const tokenExpiresAt = new Date(now.getTime() + 600 * 1000);

		expect(pushCredentialTtlSeconds(tokenExpiresAt, now)).toBe(
			ttlSecondsSchema.parse(600)
		);
	});

	it('caps the credential lifetime at six hours', () => {
		const tokenExpiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

		expect(pushCredentialTtlSeconds(tokenExpiresAt, now)).toBe(maxTtlSeconds);
	});

	it('refuses an expired authorising token', () => {
		const tokenExpiresAt = new Date(now.getTime() - 1000);

		expect(() => pushCredentialTtlSeconds(tokenExpiresAt, now)).toThrow(
			'Unauthorised'
		);
	});
});

describe('PushCredentialIssuer', () => {
	const issuer = new PushCredentialIssuer(
		() => configuration,
		pushIdSigningKeySchema.parse('signing-key'),
		tenantIdSchema.parse('acme')
	);
	const ttlSeconds = ttlSecondsSchema.parse(900);
	const issuedAt = Math.floor(now.getTime() / 1000);

	it('grants only write actions within the staging prefix', async () => {
		// R2 rejects a credential with both a scope and an actions claim, so
		// the push grants by the write-only action set alone and confines it with
		// the staging prefix.
		const credential = await issuer.issue(ttlSeconds, now);

		expect(jwtPayload(credential.sessionToken)).toStrictEqual({
			bucket: 'cupboard-blobs',
			actions: [
				'PutObject',
				'CreateMultipartUpload',
				'UploadPart',
				'CompleteMultipartUpload',
				'AbortMultipartUpload'
			],
			paths: {
				prefixPaths: [`staging/${credential.pushId}/`],
				objectPaths: []
			},
			sub: 'acct-123',
			iss: 'parent-access-key',
			aud: 'acct-123.r2.cloudflarestorage.com',
			iat: issuedAt,
			exp: issuedAt + ttlSeconds
		});
	});

	it('renews a push after the access token that started it has expired', async () => {
		const initialTtl = ttlSecondsSchema.parse(60);
		const renewedAt = new Date(now.getTime() + 90 * 1000);
		const renewedTtl = ttlSecondsSchema.parse(120);
		const initial = await issuer.issue(initialTtl, now);

		const renewed = await issuer.issueFor(
			pushIdSchema.parse(initial.pushId),
			renewedTtl,
			renewedAt
		);

		expect({
			pushId: renewed.pushId,
			payload: jwtPayload(renewed.sessionToken)
		}).toStrictEqual({
			pushId: initial.pushId,
			payload: {
				bucket: 'cupboard-blobs',
				actions: [
					'PutObject',
					'CreateMultipartUpload',
					'UploadPart',
					'CompleteMultipartUpload',
					'AbortMultipartUpload'
				],
				paths: {
					prefixPaths: [`staging/${initial.pushId}/`],
					objectPaths: []
				},
				sub: 'acct-123',
				iss: 'parent-access-key',
				aud: 'acct-123.r2.cloudflarestorage.com',
				iat: Math.floor(renewedAt.getTime() / 1000),
				exp: Math.floor(renewedAt.getTime() / 1000) + renewedTtl
			}
		});
	});

	it('bounds renewal by the push lifetime as well as the current access token', async () => {
		const initial = await issuer.issue(ttlSecondsSchema.parse(60), now);
		const nearExpiry = new Date(now.getTime() + (24 * 60 * 60 - 30) * 1000);
		const renewed = await issuer.issueFor(
			pushIdSchema.parse(initial.pushId),
			ttlSecondsSchema.parse(120),
			nearExpiry
		);
		const expired = new Date(now.getTime() + 24 * 60 * 60 * 1000);

		expect(jwtPayload(renewed.sessionToken)).toMatchObject({
			iat: Math.floor(nearExpiry.getTime() / 1000),
			exp: Math.floor(nearExpiry.getTime() / 1000) + 30
		});
		await expect(
			issuer.issueFor(
				pushIdSchema.parse(initial.pushId),
				ttlSecondsSchema.parse(120),
				expired
			)
		).rejects.toBeInstanceOf(InvalidPushIdError);
	});
});
