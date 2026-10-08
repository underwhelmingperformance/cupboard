// The vitest pool exposes the read D1 migrations as a plain `TEST_MIGRATIONS`
// binding (see vitest.config.ts) so the setup file can replay them into D1.
// `TEST_COMPRESSED_NAR_BYTES` is a NAR that Node compressed for the verifier's
// tests, and `TEST_COMPRESSED_NAR` contains the NAR's SHA-256 in hex and its
// size.
declare namespace Cloudflare {
	interface Env {
		readonly TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
		readonly TEST_COMPRESSED_NAR: {
			readonly narSha256: string;
			readonly narSize: number;
		};
		readonly TEST_COMPRESSED_NAR_BYTES: ArrayBuffer;
	}
}
