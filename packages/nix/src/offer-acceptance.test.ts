import { bytesToBase64 } from '@cupboard/nix-store/encoding';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { narFingerprint } from '@cupboard/nix-store/narinfo';
import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	type NixKeyName,
	nixKeyNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { NixSignature } from '@cupboard/nix-store/signature';
import { StorePath } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';

import type { NixSubstituterOffer } from './nix-store.ts';
import { offerAcceptance, type ReadKeyFile } from './offer-acceptance.ts';
import {
	defaultSignatureSettings,
	type NixSignatureSettings
} from './store-config.ts';

const appPath = storePathSchema.parse(
	'/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-lib'
);
const narHash = NixSha256Hash.fromDigest(new Uint8Array(32).fill(0x11));
const narSize = 4096;

function offer(
	overrides: Partial<NixSubstituterOffer> = {}
): NixSubstituterOffer {
	return {
		source: 'substituter',
		storePath: appPath,
		references: [libraryPath],
		narHash,
		narSize,
		signatures: [],
		fromTrustedSubstituter: false,
		downloadSize: 400,
		...overrides
	};
}

interface SigningKey {
	readonly published: string;
	sign(over: NixSubstituterOffer): Promise<string>;
	/** The key file Nix writes, whose last 32 bytes are the public half. */
	secretFile(): Promise<string>;
}

// `generateKey` is typed as producing either a single key or a pair, and
// Ed25519 always produces a pair, which this narrows to once.
async function generateSigningPair(): Promise<{
	readonly privateKey: CryptoKey;
	readonly publicKey: CryptoKey;
}> {
	const generated = await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	]);

	if (!('privateKey' in generated)) {
		throw new Error('Ed25519 produced a single key rather than a pair');
	}

	return generated;
}

async function signingKey(name: string): Promise<SigningKey> {
	const keyName: NixKeyName = nixKeyNameSchema.parse(name);
	const pair = await generateSigningPair();
	const rawPublic = new Uint8Array(
		await crypto.subtle.exportKey('raw', pair.publicKey)
	);

	return {
		published: NixPublicKey.of(keyName, rawPublic).value,
		async sign(over) {
			const signature = await crypto.subtle.sign(
				'Ed25519',
				pair.privateKey,
				new TextEncoder().encode(fingerprintOf(over))
			);

			return NixSignature.of(keyName, new Uint8Array(signature)).value;
		},
		async secretFile() {
			const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
			const secret = new Uint8Array(64);
			secret.set(base64UrlToBytes(jwk.d ?? ''));
			secret.set(rawPublic, 32);

			return `${keyName}:${bytesToBase64(secret)}`;
		}
	};
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/');

	return Uint8Array.from(
		atob(padded),
		(character) => character.codePointAt(0) ?? 0
	);
}

function fingerprintOf(info: NixSubstituterOffer): string {
	return narFingerprint(
		new StorePath(info.storePath),
		info.narHash.toString(),
		info.narSize,
		info.references.map((reference: StorePathString) =>
			StorePath.basename(reference)
		)
	);
}

/** A machine holding none of the configured secret key files. */
const missingKeyFiles = new Map<string, string>();
const noKeyFiles: ReadKeyFile = (filePath) => missingKeyFiles.get(filePath);

function settings(
	overrides: Partial<NixSignatureSettings> = {}
): NixSignatureSettings {
	return { ...defaultSignatureSettings, trustedPublicKeys: [], ...overrides };
}

describe('offerAcceptance', () => {
	it('takes a path signed by a key the configuration trusts', async () => {
		const key = await signingKey('cache-1');
		const signed = offer({ signatures: [await key.sign(offer())] });
		const accepts = offerAcceptance(
			settings({ trustedPublicKeys: [key.published] }),
			noKeyFiles
		);

		await expect(accepts(signed)).resolves.toBe(true);
	});

	it('refuses a path signed by a key the configuration does not trust', async () => {
		const signing = await signingKey('cache-1');
		const other = await signingKey('cache-2');
		const signed = offer({ signatures: [await signing.sign(offer())] });
		const accepts = offerAcceptance(
			settings({ trustedPublicKeys: [other.published] }),
			noKeyFiles
		);

		await expect(accepts(signed)).resolves.toBe(false);
	});

	// A signature commits to the NAR hash, size and references, so a
	// substituter serving those differently has not signed what it offers.
	it.each<{
		readonly name: string;
		readonly moved: Partial<NixSubstituterOffer>;
	}>([
		{
			name: 'a different NAR hash',
			moved: {
				narHash: NixSha256Hash.fromDigest(new Uint8Array(32).fill(0x22))
			}
		},
		{ name: 'a different NAR size', moved: { narSize: narSize + 1 } },
		{ name: 'a different reference list', moved: { references: [] } }
	])('refuses a signature made over $name', async ({ moved }) => {
		const key = await signingKey('cache-1');
		const signature = await key.sign(offer());
		const accepts = offerAcceptance(
			settings({ trustedPublicKeys: [key.published] }),
			noKeyFiles
		);

		await expect(
			accepts(offer({ ...moved, signatures: [signature] }))
		).resolves.toBe(false);
	});

	it('refuses a path carrying no signature at all', async () => {
		const key = await signingKey('cache-1');
		const accepts = offerAcceptance(
			settings({ trustedPublicKeys: [key.published] }),
			noKeyFiles
		);

		await expect(accepts(offer())).resolves.toBe(false);
	});

	// A store trusts the published half of every key it signs with, so a
	// runner's own key file names a key without listing it twice.
	it('takes a path signed by a key it holds the secret for', async () => {
		const key = await signingKey('cache-1');
		const secret = await key.secretFile();
		const signed = offer({ signatures: [await key.sign(offer())] });
		const accepts = offerAcceptance(
			settings({ secretKeyFiles: ['/etc/nix/key'] }),
			(filePath) => (filePath === '/etc/nix/key' ? secret : undefined)
		);

		await expect(accepts(signed)).resolves.toBe(true);
	});

	it('carries on past a secret key file it cannot read', async () => {
		const key = await signingKey('cache-1');
		const signed = offer({ signatures: [await key.sign(offer())] });
		const accepts = offerAcceptance(
			settings({
				trustedPublicKeys: [key.published],
				secretKeyFiles: ['/etc/nix/missing']
			}),
			noKeyFiles
		);

		await expect(accepts(signed)).resolves.toBe(true);
	});

	// A substituter named as trusted is taken at its word, which is what
	// `?trusted=1` on its store URI asks for.
	it('takes an unsigned path from a substituter configured as trusted', async () => {
		const accepts = offerAcceptance(settings(), noKeyFiles);

		await expect(
			accepts(offer({ fromTrustedSubstituter: true }))
		).resolves.toBe(true);
	});

	it('takes any path with the signature requirement turned off', async () => {
		const accepts = offerAcceptance(
			settings({ requireSignatures: false }),
			noKeyFiles
		);

		await expect(accepts(offer())).resolves.toBe(true);
	});
});
