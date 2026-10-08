import { execFileSync } from 'node:child_process';

import { onTestFinished, vi } from 'vitest';

function repositoryEnvironmentVariables(): readonly string[] {
	return execFileSync('git', ['rev-parse', '--local-env-vars'], {
		encoding: 'utf8'
	})
		.split('\n')
		.filter((name) => name !== '');
}

/**
 * Clears the repository-local variables that `git rev-parse --local-env-vars`
 * lists, until the current test finishes. Hooks and `git rebase --exec` export
 * variables such as `GIT_DIR`, and git uses them to find the repository in
 * place of the working directory. A fixture that runs `git init` would
 * otherwise operate on the caller's repository. Call this from a fixture
 * before it runs git, or before it calls code that does.
 */
export function isolateGitEnvironment(): void {
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	for (const name of repositoryEnvironmentVariables()) {
		vi.stubEnv(name, undefined);
	}
}
