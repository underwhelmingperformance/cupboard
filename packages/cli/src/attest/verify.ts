import { readFile as nodeReadFile } from 'node:fs/promises';

import { NixSha256Hash } from '@cupboard/nix/hash';
import { NarInfo } from '@cupboard/nix/narinfo';
import { storePathHashOf } from '@cupboard/nix/store-path';
import { attestationListSchema } from '@cupboard/protocol/attestations';
import { bundleFromJSON, isBundleWithDsseEnvelope } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';
import type {
	Signer,
	VerificationPolicy,
	VerifierOptions
} from '@sigstore/verify';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import { z } from 'zod';

const inTotoPayloadType = 'application/vnd.in-toto+json';
const inTotoStatementType = 'https://in-toto.io/Statement/v1';

const inTotoStatementSchema = z.object({
	_type: z.literal(inTotoStatementType),
	subject: z.array(
		z.object({
			digest: z.object({
				sha256: z.string().regex(/^[0-9a-f]{64}$/)
			})
		})
	),
	predicateType: z.string(),
	predicate: z.unknown()
});

export interface IdentityPolicyOptions {
	readonly certificateIdentity?: string;
	readonly certificateIdentityRegex?: string;
	readonly certificateOidcIssuer?: string;
	readonly certificateOidcIssuerRegex?: string;
}

export interface AttestationPolicyOptions extends IdentityPolicyOptions {
	readonly predicateType: string;
	readonly trustedRoot?: string;
	readonly tlogThreshold?: number;
	readonly ctlogThreshold?: number;
	readonly timestampThreshold?: number;
}

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

export interface VerifyResult {
	readonly bundle: string;
	readonly predicateType: string;
	readonly subjectDigest: string;
	readonly signerIdentity?: string;
	readonly signerIssuer?: string;
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

export type VerifiedIdentityPolicy =
	| {
			readonly mode: 'exact';
			readonly identity: string;
			readonly issuer: string;
	  }
	| {
			readonly mode: 'regex';
			readonly identity: RegExp;
			readonly issuer: RegExp;
	  };

interface VerifiedBundle {
	readonly signer: Signer;
	readonly predicateType: string;
	readonly subjectDigests: readonly string[];
}

interface BundleVerifyOptions extends VerifierOptions {
	readonly trustedRoot?: string;
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
	const fetcher = dependencies.fetch ?? fetch;
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

	if (storePathHashOf(narInfo.storePath) !== options.storePathHash) {
		throw new Error(
			'Remote narinfo store path does not match the requested hash'
		);
	}

	const expectedSubject = NixSha256Hash.parse(narInfo.narHash).digestHex();
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

export function identityPolicy(
	options: IdentityPolicyOptions
): VerifiedIdentityPolicy {
	const identityModes = [
		options.certificateIdentity,
		options.certificateIdentityRegex
	].filter((value) => value !== undefined);
	const issuerModes = [
		options.certificateOidcIssuer,
		options.certificateOidcIssuerRegex
	].filter((value) => value !== undefined);

	if (identityModes.length !== 1) {
		throw new Error(
			'Pass exactly one of --certificate-identity or --certificate-identity-regex'
		);
	}

	if (issuerModes.length !== 1) {
		throw new Error(
			'Pass exactly one of --certificate-oidc-issuer or --certificate-oidc-issuer-regex'
		);
	}

	if (
		options.certificateIdentity !== undefined &&
		options.certificateOidcIssuer !== undefined
	) {
		return {
			mode: 'exact',
			identity: options.certificateIdentity,
			issuer: options.certificateOidcIssuer
		};
	}

	if (
		options.certificateIdentityRegex === undefined ||
		options.certificateOidcIssuerRegex === undefined
	) {
		throw new Error(
			'Certificate identity and OIDC issuer must both use exact values or both use regex values'
		);
	}

	return {
		mode: 'regex',
		identity: new RegExp(options.certificateIdentityRegex),
		issuer: new RegExp(options.certificateOidcIssuerRegex)
	};
}

async function verifyBundle(
	bytes: Uint8Array,
	policy: VerifiedIdentityPolicy,
	options: BundleVerifyOptions
): Promise<VerifiedBundle> {
	const parsed = parseBundle(bytes);
	const trustMaterial = toTrustMaterial(await trustedRoot(options));
	const verifier = new Verifier(trustMaterial, verifierOptions(options));
	const verificationPolicy: VerificationPolicy | undefined =
		policy.mode === 'exact'
			? {
					subjectAlternativeName: policy.identity,
					extensions: { issuer: policy.issuer }
				}
			: undefined;
	const signer = verifier.verify(
		toSignedEntity(parsed.bundle),
		verificationPolicy
	);

	if (policy.mode === 'regex') {
		const signerIdentity = signer.identity?.subjectAlternativeName;
		const signerIssuer = signer.identity?.extensions?.issuer;

		if (
			signerIdentity === undefined ||
			signerIssuer === undefined ||
			!policy.identity.test(signerIdentity) ||
			!policy.issuer.test(signerIssuer)
		) {
			throw new Error('Verified signer identity did not match policy');
		}
	}

	return { signer, ...parsed };
}

function verifierOptions(options: BundleVerifyOptions): VerifierOptions {
	const thresholds: VerifierOptions = {};

	if (options.tlogThreshold !== undefined) {
		thresholds.tlogThreshold = options.tlogThreshold;
	}

	if (options.ctlogThreshold !== undefined) {
		thresholds.ctlogThreshold = options.ctlogThreshold;
	}

	if (options.timestampThreshold !== undefined) {
		thresholds.timestampThreshold = options.timestampThreshold;
	}

	return thresholds;
}

function bundleVerifyOptions(
	options: AttestationPolicyOptions
): BundleVerifyOptions {
	return {
		...(options.trustedRoot === undefined
			? {}
			: { trustedRoot: options.trustedRoot }),
		...(options.tlogThreshold === undefined
			? {}
			: { tlogThreshold: options.tlogThreshold }),
		...(options.ctlogThreshold === undefined
			? {}
			: { ctlogThreshold: options.ctlogThreshold }),
		...(options.timestampThreshold === undefined
			? {}
			: { timestampThreshold: options.timestampThreshold })
	};
}

async function trustedRoot(options: BundleVerifyOptions): Promise<TrustedRoot> {
	if (options.trustedRoot === undefined) {
		return getTrustedRoot();
	}

	return TrustedRoot.fromJSON(
		JSON.parse(await nodeReadFile(options.trustedRoot, 'utf8'))
	);
}

function parseBundle(bytes: Uint8Array): Omit<VerifiedBundle, 'signer'> & {
	readonly bundle: ReturnType<typeof bundleFromJSON>;
} {
	const bundle = bundleFromJSON(JSON.parse(new TextDecoder().decode(bytes)));

	if (!isBundleWithDsseEnvelope(bundle)) {
		throw new Error('Attestation bundle is not a Sigstore DSSE bundle');
	}

	const envelope = bundle.content.dsseEnvelope;

	if (envelope.payloadType !== inTotoPayloadType) {
		throw new Error('Attestation bundle DSSE payload is not in-toto');
	}

	const statement = inTotoStatementSchema.parse(
		JSON.parse(Buffer.from(envelope.payload).toString('utf8'))
	);

	return {
		bundle,
		predicateType: statement.predicateType,
		subjectDigests: statement.subject.map((subject) => subject.digest.sha256)
	};
}

function resultFor(
	bundle: string,
	verified: VerifiedBundle,
	expectedSubject: string,
	expectedPredicateType: string
): VerifyResult {
	if (!verified.subjectDigests.includes(expectedSubject)) {
		throw new Error('Verified attestation subject does not match the NAR hash');
	}

	if (verified.predicateType !== expectedPredicateType) {
		throw new Error(
			'Verified attestation predicate type does not match policy'
		);
	}

	return {
		bundle,
		predicateType: verified.predicateType,
		subjectDigest: expectedSubject,
		signerIdentity: verified.signer.identity?.subjectAlternativeName,
		signerIssuer: verified.signer.identity?.extensions?.issuer
	};
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

	const fingerprint = new TextEncoder().encode(narInfo.fingerprint());

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
			const verified = await crypto.subtle.verify(
				'Ed25519',
				imported,
				toArrayBuffer(parseNamedBytes(signature).bytes),
				fingerprint
			);

			if (verified) {
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

function cacheUrl(url: string, cache: string | undefined): string {
	const parsed = new URL(url);
	const basePath = parsed.pathname.replace(/\/+$/, '');

	parsed.pathname =
		cache === undefined || cache === ''
			? basePath
			: `${basePath}/cache/${cache}`;

	return trimRight(parsed.toString());
}

function trimRight(value: string): string {
	return value.replace(/\/+$/, '');
}
