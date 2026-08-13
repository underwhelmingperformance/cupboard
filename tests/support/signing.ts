/**
 * An Ed25519 pair for a test that has to sign something the way Nix signs it.
 *
 * `generateKey` is typed as producing either a pair or a single key, since the
 * algorithm decides which; Ed25519 always produces a pair, so the narrowing is
 * a check rather than a case a caller handles.
 */
export async function generateSigningPair(): Promise<{
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
