import { readFile as nodeReadFile } from 'node:fs/promises';

import { cacheUrl } from '@cupboard/nix-store/cache-url';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { attestationListSchema } from '@cupboard/protocol/attestations';
import {
	type AttestationPolicyOptions,
	type BundleVerifyOptions,
	bundleVerifyOptions,
	identityPolicy,
	resultFor,
	type VerifiedBundle,
	type VerifiedIdentityPolicy,
	verifyBundle,
	type VerifyResult
} from '@cupboard/shared/sigstore';

import { resilientFetcher } from '../client/transport.ts';

export interface LocalAttestationVerifyOptions extends AttestationPolicyOptions {
	readonly bundles: readonly string[];
	readonly narHash: string;
}

export interface RemoteAttestationVerifyOptions extends AttestationPolicyOptions {
	readonly url: string;
	readonly storePathHash: string;
	readonly cache?: string;
	readonly bundleDigest?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly trustedPublicKey?: string;
	readonly trustCachePubkey?: boolean;
	readonly signal?: AbortSignal;
}

export interface AttestationVerifyDependencies {
	readonly readFile?: (path: string) => Promise<Uint8Array>;
	readonly fetch?: typeof fetch;
	readonly verify?: (
		bundle: Uint8Array,
		policy: VerifiedIdentityPolicy,
		options: BundleVerifyOptions
	) => Promise<VerifiedBundle>;
}

export class RemoteNarInfoStorePathMismatchError extends Error {
	constructor(
		public readonly expectedStorePathHash: string,
		public readonly actualStorePathHash: string,
		public readonly storePath: string
	) {
		super('Remote narinfo store path does not match the requested hash');
		this.name = 'RemoteNarInfoStorePathMismatchError';
	}
}

export async function verifyLocalAttestations(
	options: LocalAttestationVerifyOptions,
	dependencies: AttestationVerifyDependencies = {}
): Promise<readonly VerifyResult[]> {
	const policy = identityPolicy(options);
	const expectedSubject = NixSha256Hash.parse(options.narHash).digestHex();
	const read = dependencies.readFile ?? nodeReadFile;
	const verify = dependencies.verify ?? verifyBundle;
	const results: VerifyResult[] = [];

	for (const bundlePath of options.bundles) {
		const verified = await verify(
			await read(bundlePath),
			policy,
			bundleVerifyOptions(options)
		);
		results.push(
			resultFor(bundlePath, verified, expectedSubject, options.predicateType)
		);
	}

	return results;
}

export async function verifyRemoteAttestations(
	options: RemoteAttestationVerifyOptions,
	dependencies: AttestationVerifyDependencies = {}
): Promise<readonly VerifyResult[]> {
	const policy = identityPolicy(options);
	const fetcher = dependencies.fetch ?? resilientFetcher();
	const base = cacheUrl(options.url, options.cache);
	const readHeaders = readAuthHeaders(options);
	const narInfo = await fetchNarInfo(
		fetcher,
		`${base}/${options.storePathHash}.narinfo`,
		readHeaders,
		options.signal
	);
	const publicKeys = await remoteTrustKeys(options, fetcher);

	if (!(await verifyNarInfoSignature(narInfo, publicKeys))) {
		throw new Error('Remote narinfo signature did not verify');
	}

	const actualStorePathHash = narInfo.storePath.hash;

	if (actualStorePathHash !== options.storePathHash) {
		throw new RemoteNarInfoStorePathMismatchError(
			options.storePathHash,
			actualStorePathHash,
			narInfo.storePath.value
		);
	}

	const expectedSubject = narInfo.narHash.digestHex();
	const descriptors = await fetchAttestationList(
		fetcher,
		`${base}/attestations/${options.storePathHash}`,
		readHeaders,
		options.signal
	);
	const predicateDescriptors = descriptors.filter(
		(item) => item.predicateType === options.predicateType
	);
	const selected =
		options.bundleDigest === undefined
			? predicateDescriptors
			: predicateDescriptors.filter(
					(item) => item.digest === options.bundleDigest
				);

	if (selected.length === 0) {
		throw new Error('No matching attestation bundle was found');
	}

	if (options.bundleDigest === undefined && selected.length > 1) {
		throw new Error('Multiple attestations found; pass --bundle-digest');
	}

	const verify = dependencies.verify ?? verifyBundle;

	return Promise.all(
		selected.map(async (descriptor) => {
			const bundleUrl = `${base}/attestation-bundles/${descriptor.digest}`;
			const response = await fetcher(bundleUrl, {
				headers: readHeaders,
				signal: options.signal
			});

			if (!response.ok) {
				throw new Error(
					`Could not fetch attestation bundle ${descriptor.digest}`
				);
			}

			const verified = await verify(
				new Uint8Array(await response.arrayBuffer()),
				policy,
				bundleVerifyOptions(options)
			);

			return resultFor(
				descriptor.digest,
				verified,
				expectedSubject,
				options.predicateType
			);
		})
	);
}

async function fetchNarInfo(
	fetcher: typeof fetch,
	url: string,
	headers: Headers,
	signal: AbortSignal | undefined
): Promise<NarInfo> {
	const response = await fetcher(url, { headers, signal });

	if (!response.ok) {
		throw new Error('Could not fetch remote narinfo');
	}

	return NarInfo.parse(await response.text());
}

async function fetchAttestationList(
	fetcher: typeof fetch,
	url: string,
	headers: Headers,
	signal: AbortSignal | undefined
) {
	const response = await fetcher(url, { headers, signal });

	if (!response.ok) {
		throw new Error('Could not fetch remote attestation list');
	}

	return attestationListSchema.parse(await response.json()).attestations;
}

async function remoteTrustKeys(
	options: RemoteAttestationVerifyOptions,
	fetcher: typeof fetch
): Promise<readonly string[]> {
	if (options.trustedPublicKey !== undefined && options.trustCachePubkey) {
		throw new Error('Pass only one narinfo trust source');
	}

	if (options.trustedPublicKey !== undefined) {
		return trustedPublicKeys(options.trustedPublicKey);
	}

	if (!options.trustCachePubkey) {
		throw new Error(
			'Remote verification requires --trusted-public-key or --trust-cache-pubkey'
		);
	}

	const response = await fetcher(`${trimRight(options.url)}/pubkey`, {
		signal: options.signal
	});

	if (!response.ok) {
		throw new Error('Could not fetch cache public key');
	}

	return trustedPublicKeys(await response.text());
}

function trustedPublicKeys(source: string): readonly string[] {
	const keys = source.split(/\s+/).filter(Boolean);

	if (keys.length === 0) {
		throw new Error('Narinfo trust source did not contain any public keys');
	}

	return keys;
}

function readAuthHeaders(options: RemoteAttestationVerifyOptions): Headers {
	const headers = new Headers();

	if (options.readUser === undefined && options.readPassword === undefined) {
		return headers;
	}

	if (options.readUser === undefined || options.readPassword === undefined) {
		throw new Error('Pass both --read-user and --read-password');
	}

	headers.set(
		'authorization',
		`Basic ${Buffer.from(`${options.readUser}:${options.readPassword}`).toString('base64')}`
	);

	return headers;
}

async function verifyNarInfoSignature(
	narInfo: NarInfo,
	publicKeys: readonly string[]
): Promise<boolean> {
	if (narInfo.sigs.length === 0) {
		return false;
	}

	const encoder = new TextEncoder();
	const fingerprint = encoder.encode(narInfo.fingerprint());

	for (const publicKey of publicKeys) {
		const key = parseNamedBytes(publicKey);
		const imported = await crypto.subtle.importKey(
			'raw',
			toArrayBuffer(key.bytes),
			'Ed25519',
			false,
			['verify']
		);

		for (const signature of narInfo.sigs) {
			const isVerified = await crypto.subtle.verify(
				'Ed25519',
				imported,
				toArrayBuffer(parseNamedBytes(signature).bytes),
				fingerprint
			);

			if (isVerified) {
				return true;
			}
		}
	}

	return false;
}

function parseNamedBytes(value: string): { readonly bytes: Uint8Array } {
	const separator = value.indexOf(':');

	if (separator <= 0) {
		throw new Error('Expected a name:base64 value');
	}

	return {
		bytes: Uint8Array.from(Buffer.from(value.slice(separator + 1), 'base64'))
	};
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer;
}

function trimRight(value: string): string {
	return value.replace(/\/+$/, '');
}
