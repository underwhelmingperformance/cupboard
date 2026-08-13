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

/** Reads a configured secret key file, or nothing when it cannot be read. */
export type ReadKeyFile = (filePath: string) => string | undefined;

/**
 * Builds the check a consumer applies before fetching a path from a
 * substituter: with `require-sigs` on, the path must carry at least one
 * signature from a key the consumer trusts, and a substituter configured as
 * trusted is taken at its word instead.
 *
 * The keys are the `trusted-public-keys` list plus the published half of every
 * `secret-key-files` entry, since a store trusts what it signs itself. A file
 * it cannot read names no key, which is ordinary on a machine where the keys
 * belong to another user.
 *
 * A content-addressed path is accepted by Nix without a signature, because the
 * path name commits to the contents. This asks for a signature there too:
 * reconstructing a store path from a content address to prove the exemption
 * applies would, if it were ever wrong, waive the signature requirement on a
 * path that has not earned it, and a path refused here is built rather than
 * left upstream.
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

		return trusted.verifies(offerFingerprint(offer), offer.signatures);
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
