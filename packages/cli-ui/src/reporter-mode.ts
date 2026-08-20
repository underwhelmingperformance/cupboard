import { env, stderr } from 'node:process';

import type { ReporterMode } from '@cupboard/reporter';
import { isGithubActions } from '@cupboard/shared/github-actions';

/**
 * Resolves a CLI's reporter mode from its `--output-mode` flag and the
 * environment. An explicit `--output-mode` wins; otherwise the precedence is
 * `FORCE_COLOR` > `PRE_COMMIT` > GitHub Actions > whether stderr is a TTY.
 * `FORCE_COLOR` forces the spinner even with no TTY (a CI that captures a
 * terminal); pre-commit hooks default to JSON because pre-commit captures hook
 * output even when stderr is a TTY; a GitHub Actions runner gets workflow-command
 * output. The colour flags and `NO_COLOR` configure colour separately and do
 * not select the reporter mode.
 */
export function resolveReporterMode(mode?: ReporterMode): ReporterMode {
	if (mode !== undefined) {
		return mode;
	}

	if (
		env.FORCE_COLOR !== undefined &&
		env.FORCE_COLOR !== '' &&
		env.FORCE_COLOR !== '0'
	) {
		return 'terminal';
	}

	if (env.PRE_COMMIT === '1') {
		return 'json';
	}

	if (isGithubActions()) {
		return 'github';
	}

	return stderr.isTTY ? 'terminal' : 'json';
}
