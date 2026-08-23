import { narFingerprint } from '@cupboard/nix-store/narinfo';
import {
	type NixFingerprint,
	storePathBasenameSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { NixTrustedKeys, publicKeyOfSecret } from '@cupboard/nix-store/verify';

import type { NixSubstituterOffer } from './nix-store.ts';
import type { NixSignatureSettings } from './store-config.ts';
import type { AcceptsOffer } from './substitutable-closure.ts';

export type ReadKeyFile = (filePath: string) => string | undefined;

/**
 * Creates the acceptance policy for offers discovered through substituters.
 * Disabling `require-sigs` accepts every offer. Otherwise, an offer must come
 * from a trusted substituter or have a valid signature from a configured
 * public key or the public half of a readable secret key. An unreadable or
 * malformed secret key file contributes no key.
 *
 * Nix exempts content-addressed paths from the signature requirement. This
 * policy does not, because applying that exemption safely would require
 * reconstructing and validating the store path from the content address. A
 * false rejection makes Nix build the path; a false exemption could fetch
 * unverified contents.
 */
export function offerAcceptance(
	settings: NixSignatureSettings,
	readKeyFile: ReadKeyFile
): AcceptsOffer {
	if (!settings.requireSignatures) {
		return () => Promise.resolve(true);
	}

	const trusted = NixTrustedKeys.of([
		...settings.trustedPublicKeys,
		...publishedHalves(settings.secretKeyFiles, readKeyFile)
	]);

	return (offer) => {
		if (offer.fromTrustedSubstituter) {
			return Promise.resolve(true);
		}

		return trusted.hasValidSignature(offerFingerprint(offer), offer.signatures);
	};
}

function publishedHalves(
	filePaths: readonly string[],
	readKeyFile: ReadKeyFile
): readonly string[] {
	return filePaths.flatMap((filePath) => {
		const contents = readKeyFile(filePath);
		const published =
			contents === undefined ? undefined : publicKeyOfSecret(contents);

		return published === undefined ? [] : [published.value];
	});
}

// Nix signatures cover the store path, uncompressed NAR hash and size, and
// reference basenames.
function offerFingerprint(offer: NixSubstituterOffer): NixFingerprint {
	return narFingerprint(
		new StorePath(offer.storePath),
		offer.narHash.toString(),
		offer.narSize,
		offer.references.map((reference) =>
			storePathBasenameSchema.parse(StorePath.basename(reference))
		)
	);
}
