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

/**
Reads a configured secret key file, or returns `undefined` on failure.
*/
export type ReadKeyFile = (filePath: string) => string | undefined;

/**
 * Builds the policy check applied before fetching a path from a
 * substituter: with `require-sigs` on, the path must carry at least one
 * signature from a key the consumer trusts, and a substituter configured as
 * trusted is accepted without a signature.
 *
 * The keys are the `trusted-public-keys` list plus the published half of every
 * `secret-key-files` entry, since a store trusts what it signs itself. A file
 * this process cannot read contributes no key, which is ordinary on a machine
 * where the keys belong to another user.
 *
 * A content-addressed path is accepted by Nix without a signature, because the
 * path name commits to the contents. This implementation still requires a
 * signature. Applying the exemption would mean reconstructing the store path
 * from the content address, and a mistake there would drop the signature
 * requirement for a path that does not qualify. The cost of refusing an offer
 * here is only that Nix builds the path instead of fetching it.
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

// The fingerprint a signature is made over, which commits to the uncompressed
// NAR and the references.
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
