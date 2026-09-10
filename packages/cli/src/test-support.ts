import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, vi } from 'vitest';

interface ConfigHomeFixture {
	readonly configHome: string;
}

/**
 * Runs a test with `$XDG_CONFIG_HOME` pointed at a fresh temporary directory,
 * then removes the directory and restores the environment afterwards. Lets the
 * token-cache tests exercise the real on-disk store without leaking directories.
 */
export const testWithConfigHome = test.extend<ConfigHomeFixture>({
	// `auto` so the temporary config home is set up and torn down for every test,
	// including those that depend on the stubbed environment without reading the
	// directory path.
	// Vitest requires a fixture's first argument to be an object-destructuring
	// pattern, and the linter forbids an empty one; this fixture needs nothing
	// from the context, so it destructures the built-in `task` and ignores it.
	configHome: [
		async ({ task: _task }, use) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-config-'));
			vi.stubEnv('XDG_CONFIG_HOME', directory);

			try {
				await use(directory);
			} finally {
				vi.unstubAllEnvs();
				await rm(directory, { recursive: true, force: true });
			}
		},
		{ auto: true }
	]
});
