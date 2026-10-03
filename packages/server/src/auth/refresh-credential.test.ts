import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../crypto/crypto.ts';

import {
	RefreshCredential,
	refreshCredentialMaxBytes
} from './refresh-credential.ts';

const tenant = tenantIdSchema.parse('acme');
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
		const credential = RefreshCredential.issue(payload);
		const parsed = RefreshCredential.parse(credential.value);

		expect(
			await parsed?.authenticate(await sha256Hex(credential.value), tenant)
		).toStrictEqual(payload);
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
		const credential = RefreshCredential.issue(payload);

		expect(
			await RefreshCredential.parse(tamper(credential.value))?.authenticate(
				await sha256Hex(credential.value),
				tenant
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
				tenant
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

	it('rejects an issued credential that exceeds the redeemable byte limit', () => {
		expect(() =>
			RefreshCredential.issue({
				...payload,
				identity: {
					...payload.identity,
					team: 'x'.repeat(refreshCredentialMaxBytes)
				}
			})
		).toThrow('Refresh credential exceeds the 65536-byte limit');
	});
});
