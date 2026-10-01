import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { attestationInfoCapability } from '@cupboard/protocol/attestations';
import { cacheMetadataCapabilityHeader } from '@cupboard/protocol/cache-metadata';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CupboardHttpError } from '../errors.ts';

import {
	InvalidAttestationDiscoveryError,
	readAttestationInfo
} from './status.ts';

const server = setupServer();
const url = new URL('https://cache.example.test/t/acme');
const hash = storePathHashSchema.parse('0123456789abcdfghijklmnpqrsvwxyz');
const narHash = nixSha256HashSchema.parse(
	'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347'
);
const descriptor = {
	digest: 'a'.repeat(64),
	predicateType: 'https://slsa.dev/provenance/v1',
	size: 100
};
const options = {
	url,
	cache: { kind: 'default' as const },
	storePathHashes: [hash]
};
const narinfo = `StorePath: /nix/store/${hash}-app\nURL: nar/app.nar\nCompression: zstd\nFileHash: ${narHash}\nFileSize: 1\nNarHash: ${narHash}\nNarSize: 1\nReferences: \n`;

beforeAll(() => {
	server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
	server.resetHandlers();
});
afterAll(() => {
	server.close();
});

function capability(value?: string): void {
	server.use(
		http.get(
			`${url.href}/nix-cache-info`,
			() =>
				new HttpResponse('StoreDir: /nix/store\n', {
					headers:
						value === undefined
							? {}
							: { [cacheMetadataCapabilityHeader]: value }
				})
		)
	);
}

describe('attestation discovery client', () => {
	it('reads the current credential from an explicitly selected renewable netrc', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-status-netrc-')
		);
		const netrcFile = path.join(directory, 'netrc');
		try {
			await writeFile(
				netrcFile,
				'machine cache.example.test login cupboard-oidc password current-token\n',
				{ mode: 0o600 }
			);
			const authorizations: (string | null)[] = [];
			server.use(
				http.get(`${url.href}/nix-cache-info`, ({ request }) => {
					authorizations.push(request.headers.get('authorization'));
					return new HttpResponse('', {
						headers: {
							[cacheMetadataCapabilityHeader]: attestationInfoCapability
						}
					});
				}),
				http.post(`${url.href}/api/v1/attestation-info`, ({ request }) => {
					authorizations.push(request.headers.get('authorization'));
					return HttpResponse.json({
						scopeVersion: 'cache:1:1:private:false',
						entries: [{ storePathHash: hash, status: 'missing' }]
					});
				})
			);
			const input = { ...options, netrcFile };
			const entries = await readAttestationInfo(input, fetch);
			expect({ entries, authorizations }).toStrictEqual({
				entries: [{ storePathHash: hash, status: 'missing' }],
				authorizations: Array.from(
					{ length: 2 },
					() =>
						`Basic ${Buffer.from('cupboard-oidc:current-token').toString('base64')}`
				)
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('uses the advertised batch capability and preserves its ordered results', async () => {
		capability(`path-info-v1 ${attestationInfoCapability}`);
		const requests: unknown[] = [];
		server.use(
			http.post(`${url.href}/api/v1/attestation-info`, async ({ request }) => {
				requests.push(await request.json());
				return HttpResponse.json({
					scopeVersion: 'cache:1:1:public:false',
					entries: [
						{
							storePathHash: hash,
							status: 'found',
							narHash,
							attestations: [descriptor]
						}
					]
				});
			})
		);
		const entries = await readAttestationInfo(options, fetch);
		expect({ requests, entries }).toStrictEqual({
			requests: [{ storePathHashes: [hash] }],
			entries: [
				{
					storePathHash: hash,
					status: 'found',
					narHash,
					attestations: [descriptor]
				}
			]
		});
	});

	it('falls back to bounded individual lists only when the capability is absent', async () => {
		capability('path-info-v1');
		server.use(
			http.get(`${url.href}/${hash}.narinfo`, () => new HttpResponse(narinfo)),
			http.get(`${url.href}/attestations/${hash}`, () =>
				HttpResponse.json({ attestations: [descriptor] })
			)
		);
		expect(await readAttestationInfo(options, fetch)).toStrictEqual([
			{
				storePathHash: hash,
				status: 'found',
				narHash,
				attestations: [descriptor]
			}
		]);
	});

	it.each([401, 403, 503])(
		'does not fall back after HTTP %s from discovery',
		async (status) => {
			capability(attestationInfoCapability);
			server.use(
				http.post(
					`${url.href}/api/v1/attestation-info`,
					() => new HttpResponse('refused', { status })
				)
			);
			await expect(readAttestationInfo(options, fetch)).rejects.toBeInstanceOf(
				CupboardHttpError
			);
		}
	);

	it('pages at the advertised limit and reuses the scope version', async () => {
		capability(attestationInfoCapability);
		const hashes = Array.from({ length: 33 }, (_, index) =>
			storePathHashSchema.parse(index.toString(2).padStart(32, '0'))
		);
		const requests: unknown[] = [];
		server.use(
			http.post(`${url.href}/api/v1/attestation-info`, async ({ request }) => {
				const body: unknown = await request.json();
				requests.push(body);
				const group =
					requests.length === 1 ? hashes.slice(0, 32) : hashes.slice(32);
				return HttpResponse.json({
					scopeVersion: 'current',
					entries: group.map((storePathHash) => ({
						storePathHash,
						status: 'missing'
					}))
				});
			})
		);
		const entries = await readAttestationInfo(
			{ ...options, storePathHashes: hashes },
			fetch
		);
		expect({ requests, entries }).toStrictEqual({
			requests: [
				{ storePathHashes: hashes.slice(0, 32) },
				{ storePathHashes: hashes.slice(32), expectedScopeVersion: 'current' }
			],
			entries: hashes.map((storePathHash) => ({
				storePathHash,
				status: 'missing'
			}))
		});
	});

	it('continues after the processed prefix instead of skipping the rest of a page', async () => {
		capability(attestationInfoCapability);
		const second = storePathHashSchema.parse('0'.repeat(32));
		const requests: unknown[] = [];
		server.use(
			http.post(`${url.href}/api/v1/attestation-info`, async ({ request }) => {
				requests.push(await request.json());
				const isFirst = requests.length === 1;
				return HttpResponse.json({
					scopeVersion: 'current',
					entries: [
						{ storePathHash: isFirst ? hash : second, status: 'missing' }
					],
					...(isFirst && { nextIndex: 1 })
				});
			})
		);
		const entries = await readAttestationInfo(
			{ ...options, storePathHashes: [hash, second] },
			fetch
		);
		expect({ requests, entries }).toStrictEqual({
			requests: [
				{ storePathHashes: [hash, second] },
				{ storePathHashes: [second], expectedScopeVersion: 'current' }
			],
			entries: [
				{ storePathHash: hash, status: 'missing' },
				{ storePathHash: second, status: 'missing' }
			]
		});
	});

	it.each([
		{ entries: [], nextIndex: 0 },
		{ entries: [{ storePathHash: '0'.repeat(32), status: 'missing' }] },
		{ entries: [], nextIndex: undefined }
	])('rejects malformed discovery pages %j', async (page) => {
		capability(attestationInfoCapability);
		server.use(
			http.post(`${url.href}/api/v1/attestation-info`, () =>
				HttpResponse.json({ scopeVersion: 'current', ...page })
			)
		);
		await expect(readAttestationInfo(options, fetch)).rejects.toBeInstanceOf(
			InvalidAttestationDiscoveryError
		);
	});

	it('does not silently repair malformed UTF-8 in an old-server list', async () => {
		capability();
		const encoder = new TextEncoder();
		const prefix = encoder.encode(
			`{"attestations":[{"digest":"${descriptor.digest}","predicateType":"https://example.org/`
		);
		const suffix = encoder.encode('","size":1}]}');
		const body = new Uint8Array([...prefix, 255, ...suffix]);
		server.use(
			http.get(`${url.href}/${hash}.narinfo`, () => new HttpResponse(narinfo)),
			http.get(`${url.href}/attestations/${hash}`, () => new HttpResponse(body))
		);
		await expect(readAttestationInfo(options, fetch)).rejects.toBeInstanceOf(
			InvalidAttestationDiscoveryError
		);
	});
});
