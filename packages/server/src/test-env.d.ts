// The vitest pool exposes the read D1 migrations as a plain `TEST_MIGRATIONS`
// binding (see vitest.config.ts) so the setup file can replay them into D1.
declare namespace Cloudflare {
	interface Env {
		readonly TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
	}
}
