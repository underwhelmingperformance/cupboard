import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	sign
} from 'node:crypto';

const ecdsaWithSha256 = '1.2.840.10045.4.3.2';
const sha256 = '2.16.840.1.101.3.4.2.1';
const commonName = '2.5.4.3';
const basicConstraints = '2.5.29.19';
const subjectAlternativeName = '2.5.29.17';
const fulcioIssuerV2 = '1.3.6.1.4.1.57264.1.8';
const signedDataContentType = '1.2.840.113549.1.7.2';
const tstInfoContentType = '1.2.840.113549.1.9.16.1.4';
const contentTypeAttribute = '1.2.840.113549.1.9.3';
const messageDigestAttribute = '1.2.840.113549.1.9.4';
const timestampPolicy = '1.3.6.1.4.1.57264.2';

const inTotoPayloadType = 'application/vnd.in-toto+json';

const signingTime = new Date('2025-06-01T12:00:00Z');
export const signerIdentity =
	'https://github.com/underwhelmingperformance/cupboard/.github/workflows/publish.yml@refs/heads/main';
export const signerIssuer = 'https://token.actions.githubusercontent.com';

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;

	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}

	return joined;
}

function encodedLength(byteLength: number): Uint8Array {
	if (byteLength < 0x80) {
		return Uint8Array.of(byteLength);
	}

	const bytes: number[] = [];

	for (let rest = byteLength; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest % 256);
	}

	return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function tagged(tag: number, ...contents: readonly Uint8Array[]): Uint8Array {
	const body = concatenate(contents);

	return concatenate([
		Uint8Array.of(tag),
		encodedLength(body.byteLength),
		body
	]);
}

function sequence(...contents: readonly Uint8Array[]): Uint8Array {
	return tagged(0x30, ...contents);
}

function set(...contents: readonly Uint8Array[]): Uint8Array {
	return tagged(0x31, ...contents);
}

function explicit(
	number: number,
	...contents: readonly Uint8Array[]
): Uint8Array {
	return tagged(0xa0 | number, ...contents);
}

function integer(value: number): Uint8Array {
	const bytes: number[] = [];

	for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest % 256);
	}

	if (bytes.length === 0) {
		bytes.push(0);
	}

	const first = bytes[0];

	if (first !== undefined && first >= 0x80) {
		bytes.unshift(0);
	}

	return tagged(0x02, Uint8Array.from(bytes));
}

function objectIdentifier(dotted: string): Uint8Array {
	const parts = dotted.split('.').map(Number);
	const [first = 0, second = 0, ...rest] = parts;
	const bytes: number[] = [first * 40 + second];

	for (const part of rest) {
		const chunks: number[] = [part % 0x80];

		for (
			let value = Math.floor(part / 0x80);
			value > 0;
			value = Math.floor(value / 0x80)
		) {
			chunks.unshift((value % 0x80) | 0x80);
		}

		bytes.push(...chunks);
	}

	return tagged(0x06, Uint8Array.from(bytes));
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

function sha256Digest(contents: Uint8Array): Uint8Array {
	return new Uint8Array(createHash('sha256').update(contents).digest());
}

function utf8String(text: string): Uint8Array {
	return tagged(0x0c, ascii(text));
}

function octetString(contents: Uint8Array): Uint8Array {
	return tagged(0x04, contents);
}

function bitString(contents: Uint8Array): Uint8Array {
	return tagged(0x03, concatenate([Uint8Array.of(0), contents]));
}

function derBoolean(isTrue: boolean): Uint8Array {
	return tagged(0x01, Uint8Array.of(isTrue ? 0xff : 0x00));
}

function twoDigits(value: number): string {
	return String(value).padStart(2, '0');
}

function utcTime(when: Date): Uint8Array {
	const text = [
		twoDigits(when.getUTCFullYear() % 100),
		twoDigits(when.getUTCMonth() + 1),
		twoDigits(when.getUTCDate()),
		twoDigits(when.getUTCHours()),
		twoDigits(when.getUTCMinutes()),
		twoDigits(when.getUTCSeconds())
	].join('');

	return tagged(0x17, ascii(`${text}Z`));
}

function generalizedTime(when: Date): Uint8Array {
	const text = [
		String(when.getUTCFullYear()),
		twoDigits(when.getUTCMonth() + 1),
		twoDigits(when.getUTCDate()),
		twoDigits(when.getUTCHours()),
		twoDigits(when.getUTCMinutes()),
		twoDigits(when.getUTCSeconds())
	].join('');

	return tagged(0x18, ascii(`${text}Z`));
}

function algorithmIdentifier(oid: string): Uint8Array {
	return sequence(objectIdentifier(oid));
}

function distinguishedName(name: string): Uint8Array {
	const attribute = sequence(objectIdentifier(commonName), utf8String(name));

	return sequence(set(attribute));
}

function extension(
	oid: string,
	isCritical: boolean,
	value: Uint8Array
): Uint8Array {
	const parts = [objectIdentifier(oid)];

	if (isCritical) {
		parts.push(derBoolean(true));
	}

	parts.push(octetString(value));

	return sequence(...parts);
}

interface KeyPair {
	readonly privateKey: KeyObject;
	readonly publicKey: KeyObject;
}

function generateKeyPair(): KeyPair {
	return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function subjectPublicKeyInfo(key: KeyObject): Uint8Array {
	return new Uint8Array(key.export({ format: 'der', type: 'spki' }));
}

interface CertificateFields {
	readonly subject: string;
	readonly issuer: string;
	readonly serialNumber: number;
	readonly subjectKey: KeyObject;
	readonly issuerKey: KeyObject;
	readonly extensions: readonly Uint8Array[];
}

/**
 * The verifier chains a certificate to its issuer by comparing subject and
 * issuer names, so the fixture carries neither a subject key identifier nor an
 * authority key identifier.
 */
function certificate(fields: CertificateFields): Uint8Array {
	const notBefore = new Date(signingTime.getTime() - 3_600_000);
	const notAfter = new Date(signingTime.getTime() + 3_600_000);
	const toBeSigned = sequence(
		explicit(0, integer(2)),
		integer(fields.serialNumber),
		algorithmIdentifier(ecdsaWithSha256),
		distinguishedName(fields.issuer),
		sequence(utcTime(notBefore), utcTime(notAfter)),
		distinguishedName(fields.subject),
		subjectPublicKeyInfo(fields.subjectKey),
		explicit(3, sequence(...fields.extensions))
	);

	return sequence(
		toBeSigned,
		algorithmIdentifier(ecdsaWithSha256),
		bitString(sign('sha256', toBeSigned, fields.issuerKey))
	);
}

function certificateAuthorityExtension(): Uint8Array {
	return extension(basicConstraints, true, sequence(derBoolean(true)));
}

function certificateAuthority(
	name: string,
	key: KeyPair,
	serialNumber: number
): Uint8Array {
	return certificate({
		subject: name,
		issuer: name,
		serialNumber,
		subjectKey: key.publicKey,
		issuerKey: key.privateKey,
		extensions: [certificateAuthorityExtension()]
	});
}

/**
 * The RFC 3161 response from the timestamp authority for one signature.
 * `imprint` contains the exact signature bytes from the bundle. The verifier
 * hashes these bytes when it checks the timestamp.
 */
function timestampResponse(
	imprint: Uint8Array,
	authority: {
		readonly name: string;
		readonly serialNumber: number;
		readonly key: KeyObject;
	}
): Uint8Array {
	const messageImprint = sequence(
		algorithmIdentifier(sha256),
		octetString(sha256Digest(imprint))
	);
	const tstInfo = sequence(
		integer(1),
		objectIdentifier(timestampPolicy),
		messageImprint,
		integer(1),
		generalizedTime(signingTime)
	);
	const contentType = set(objectIdentifier(tstInfoContentType));
	const digest = set(octetString(sha256Digest(tstInfo)));
	const attributes = [
		sequence(objectIdentifier(contentTypeAttribute), contentType),
		sequence(objectIdentifier(messageDigestAttribute), digest)
	];
	// The signature covers the signed attributes tagged as a SET, while the
	// token carries them under a context-specific tag. Both encodings share
	// every byte but the first.
	const signature = sign('sha256', set(...attributes), authority.key);
	const signerIdentifier = sequence(
		distinguishedName(authority.name),
		integer(authority.serialNumber)
	);
	const signerInfo = sequence(
		integer(1),
		signerIdentifier,
		algorithmIdentifier(sha256),
		explicit(0, ...attributes),
		algorithmIdentifier(ecdsaWithSha256),
		octetString(signature)
	);
	const encapsulatedContent = sequence(
		objectIdentifier(tstInfoContentType),
		explicit(0, octetString(tstInfo))
	);
	const signedData = sequence(
		integer(3),
		set(algorithmIdentifier(sha256)),
		encapsulatedContent,
		set(signerInfo)
	);
	const token = sequence(
		objectIdentifier(signedDataContentType),
		explicit(0, signedData)
	);

	return sequence(sequence(integer(0)), token);
}

function preAuthenticationEncoding(payload: Uint8Array): Uint8Array {
	const header = ascii(
		`DSSEv1 ${String(inTotoPayloadType.length)} ${inTotoPayloadType} ${String(payload.byteLength)} `
	);

	return concatenate([header, payload]);
}

const base64 = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString('base64');

export interface BundleFixture {
	/**
	 * The bundle bytes, as `cupboard attest verify` reads them from a file.
	 */
	readonly bundle: Uint8Array;
	/**
	 * The trusted root document, in the form `gh attestation trusted-root`
	 * writes.
	 */
	readonly trustedRoot: string;
	readonly subjectDigest: string;
	readonly predicateType: string;
}

export interface BundleFixtureOptions {
	readonly subjectDigest: string;
	readonly predicateType: string;
	readonly predicate?: unknown;
}

/**
 * A bundle in the shape GitHub's Sigstore instance produces: a certificate
 * from a private Fulcio, an RFC 3161 timestamp from a private timestamp
 * authority, and no transparency-log entry. The bundle and the trusted root
 * that verifies it are generated together from throwaway keys, so verification
 * runs the real signature, chain and timestamp checks and contacts no service.
 *
 * The certificate validity window and the timestamp both sit at `signingTime`,
 * and the verifier takes its verification time from the timestamp, so the
 * fixture neither expires nor depends on the clock.
 */
export function githubInstanceBundle(
	options: BundleFixtureOptions
): BundleFixture {
	const fulcioRoot = generateKeyPair();
	const timestampRoot = generateKeyPair();
	const timestampLeafKey = generateKeyPair();
	const signingKey = generateKeyPair();
	const fulcioRootName = 'cupboard test Fulcio root';
	const timestampRootName = 'cupboard test timestamp root';
	const timestampLeafSerialNumber = 0x11;
	const subject = {
		name: 'subject',
		digest: { sha256: options.subjectDigest }
	};
	const statement = ascii(
		JSON.stringify({
			_type: 'https://in-toto.io/Statement/v1',
			subject: [subject],
			predicateType: options.predicateType,
			predicate: options.predicate ?? {}
		})
	);
	const signature = sign(
		'sha256',
		preAuthenticationEncoding(statement),
		signingKey.privateKey
	);
	// The signer identity travels as a URI in the subject alternative name,
	// which is where the verifier reads it from.
	const generalNames = sequence(tagged(0x86, ascii(signerIdentity)));
	const signingCertificate = certificate({
		subject: 'cupboard test workload',
		issuer: fulcioRootName,
		serialNumber: 0x2a,
		subjectKey: signingKey.publicKey,
		issuerKey: fulcioRoot.privateKey,
		extensions: [
			extension(subjectAlternativeName, true, generalNames),
			extension(fulcioIssuerV2, false, utf8String(signerIssuer))
		]
	});
	const timestampLeaf = certificate({
		subject: 'cupboard test timestamp authority',
		issuer: timestampRootName,
		serialNumber: timestampLeafSerialNumber,
		subjectKey: timestampLeafKey.publicKey,
		issuerKey: timestampRoot.privateKey,
		extensions: []
	});
	const timestamp = timestampResponse(signature, {
		name: timestampRootName,
		serialNumber: timestampLeafSerialNumber,
		key: timestampLeafKey.privateKey
	});

	return {
		subjectDigest: options.subjectDigest,
		predicateType: options.predicateType,
		bundle: ascii(
			JSON.stringify({
				mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
				verificationMaterial: {
					certificate: { rawBytes: base64(signingCertificate) },
					tlogEntries: [],
					timestampVerificationData: {
						rfc3161Timestamps: [{ signedTimestamp: base64(timestamp) }]
					}
				},
				dsseEnvelope: {
					payload: base64(statement),
					payloadType: inTotoPayloadType,
					signatures: [{ sig: base64(signature), keyid: '' }]
				}
			})
		),
		trustedRoot: JSON.stringify({
			mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
			tlogs: [],
			ctlogs: [],
			certificateAuthorities: [
				{
					subject: { organization: 'cupboard', commonName: fulcioRootName },
					certChain: {
						certificates: [
							{
								rawBytes: base64(
									certificateAuthority(fulcioRootName, fulcioRoot, 0x01)
								)
							}
						]
					}
				}
			],
			timestampAuthorities: [
				{
					subject: { organization: 'cupboard', commonName: timestampRootName },
					certChain: {
						certificates: [
							{ rawBytes: base64(timestampLeaf) },
							{
								rawBytes: base64(
									certificateAuthority(timestampRootName, timestampRoot, 0x02)
								)
							}
						]
					}
				}
			]
		})
	};
}
