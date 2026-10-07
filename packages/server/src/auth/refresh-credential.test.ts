import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { describe, expect, it } from 'vitest';

import { pushIdSigningKeySchema } from '../blob/push-id.ts';
import { sha256Hex } from '../crypto/crypto.ts';
import { RefreshCredentialSizeLimitError } from '../errors.ts';

import {
	RefreshCredential,
	refreshCredentialMaxBytes,
	type RefreshKeyContext
} from './refresh-credential.ts';

const tenant = tenantIdSchema.parse('acme');
const keys: RefreshKeyContext = {
	kind: 'tenant',
	signingKey: pushIdSigningKeySchema.parse('test-push-id-signing-key'),
	tenant
};
// The same secret as the tenant keys, so only the binding tells them apart.
const controlKeys: RefreshKeyContext = {
	kind: 'control',
	wrappingSecret: 'test-push-id-signing-key'
};
const payload = {
	purpose: 'cupboard-refresh' as const,
	version: 1 as const,
	tenant,
	familyId: '640b154c-1797-45b4-a1db-4d728289adcc',
	memberId: '188b3ca7-3071-41a0-b0c0-c716f6b557fe',
	generation: 0,
	expiresAt: isoTimestamp(new Date('2026-11-01T00:00:00.000Z')),
	identity: {
		iss: 'https://issuer.example',
		sub: 'alice',
		aud: ['cupboard', 'other'],
		team: 'engineering'
	},
	grants: [{ type: 'cupboard_wildcard' as const }]
};

describe('RefreshCredential', () => {
	it('authenticates the complete credential before returning verified policy claims', async () => {
		const credential = await RefreshCredential.issue(payload, keys);
		const parsed = RefreshCredential.parse(credential.value);

		expect(
			await parsed?.authenticate(await sha256Hex(credential.value), keys)
		).toStrictEqual({ ...payload, version: 2 });
	});

	it('binds a control credential to the control plane', async () => {
		const credential = await RefreshCredential.issue(payload, controlKeys);
		const hash = await sha256Hex(credential.value);
		const { tenant: _tenant, ...claims } = payload;

		expect({
			control: await RefreshCredential.parse(credential.value)?.authenticate(
				hash,
				controlKeys
			),
			tenant: await RefreshCredential.parse(credential.value)?.authenticate(
				hash,
				keys
			)
		}).toStrictEqual({
			control: {
				...claims,
				purpose: 'cupboard-control-refresh',
				version: 2
			},
			tenant: undefined
		});
	});

	it('rejects a tenant credential at the control plane', async () => {
		const credential = await RefreshCredential.issue(payload, keys);

		expect(
			await RefreshCredential.parse(credential.value)?.authenticate(
				await sha256Hex(credential.value),
				controlKeys
			)
		).toBeUndefined();
	});

	it('rejects a readable version 1 authority at the control plane', async () => {
		const { tenant: _tenant, ...claims } = payload;
		const encoded = bytesToBase64Url(
			new TextEncoder().encode(
				JSON.stringify({ ...claims, purpose: 'cupboard-control-refresh' })
			)
		);
		const value = `${payload.memberId}.${'a'.repeat(64)}.${encoded}`;

		expect(
			await RefreshCredential.parse(value)?.authenticate(
				await sha256Hex(value),
				controlKeys
			)
		).toBeUndefined();
	});

	it('accepts a version 1 credential with a readable authority', async () => {
		const encoded = bytesToBase64Url(
			new TextEncoder().encode(JSON.stringify(payload))
		);
		const value = `${payload.memberId}.${'a'.repeat(64)}.${encoded}`;

		expect(
			await RefreshCredential.parse(value)?.authenticate(
				await sha256Hex(value),
				keys
			)
		).toStrictEqual(payload);
	});

	it('seals the authority so the credential does not contain it', async () => {
		const credential = await RefreshCredential.issue(payload, keys);
		const readable = bytesToBase64Url(
			new TextEncoder().encode(JSON.stringify({ ...payload, version: 2 }))
		);

		expect({
			segments: credential.value.split('.').length,
			containsAuthority: credential.value.includes(readable.slice(0, 32))
		}).toStrictEqual({ segments: 4, containsAuthority: false });
	});

	it.each([
		[
			'signing key',
			{
				...keys,
				signingKey: pushIdSigningKeySchema.parse('rotated-signing-key')
			}
		],
		['tenant', { ...keys, tenant: tenantIdSchema.parse('other') }]
	])('rejects a sealed authority under another %s', async (_part, context) => {
		const credential = await RefreshCredential.issue(payload, keys);

		expect(
			await RefreshCredential.parse(credential.value)?.authenticate(
				await sha256Hex(credential.value),
				context
			)
		).toBeUndefined();
	});

	it.each([
		[
			'payload',
			(value: string) => `${value.slice(0, value.lastIndexOf('.') + 1)}e30`
		],
		[
			'secret',
			(value: string) =>
				value.replace(/\.[a-f0-9]{64}\./u, () => `.${'0'.repeat(64)}.`)
		],
		[
			'lookup id',
			(value: string) => value.replace(payload.memberId, () => payload.familyId)
		]
	])('rejects tampering with the %s', async (_part, tamper) => {
		const credential = await RefreshCredential.issue(payload, keys);

		expect(
			await RefreshCredential.parse(tamper(credential.value))?.authenticate(
				await sha256Hex(credential.value),
				keys
			)
		).toBeUndefined();
	});

	it.each([
		['purpose', { ...payload, purpose: 'cupboard-access' }],
		['version', { ...payload, version: 2 }],
		['tenant', { ...payload, tenant: 'other' }],
		[
			'identity',
			{ ...payload, identity: { ...payload.identity, team: ['engineering'] } }
		],
		['member', { ...payload, memberId: payload.familyId }],
		['expiry', { ...payload, expiresAt: 'tomorrow' }],
		['extra fields', { ...payload, externalToken: 'secret' }]
	])('rejects an authenticated invalid %s', async (_field, invalid) => {
		const encoded = bytesToBase64Url(
			new TextEncoder().encode(JSON.stringify(invalid))
		);
		const value = `${payload.memberId}.${'a'.repeat(64)}.${encoded}`;

		expect(
			await RefreshCredential.parse(value)?.authenticate(
				await sha256Hex(value),
				keys
			)
		).toBeUndefined();
	});

	it.each([
		'legacy.secret',
		'eyJhbGciOiJFZERTQSJ9.payload.signature',
		'x'.repeat(refreshCredentialMaxBytes + 1)
	])('rejects unsupported credential syntax', (value) => {
		expect(RefreshCredential.parse(value)).toBeUndefined();
	});

	it('rejects an issued credential that exceeds the redeemable byte limit', async () => {
		await expect(
			RefreshCredential.issue(
				{
					...payload,
					identity: {
						...payload.identity,
						team: 'x'.repeat(refreshCredentialMaxBytes)
					}
				},
				keys
			)
		).rejects.toBeInstanceOf(RefreshCredentialSizeLimitError);
	});
});
