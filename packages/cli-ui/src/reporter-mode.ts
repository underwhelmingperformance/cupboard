import { env, stderr } from 'node:process';

import type { ReporterMode } from '@cupboard/reporter';
import { isGithubActions } from '@cupboard/shared/github-actions';

/**
 * Resolve a CLI's reporter mode from its `--output-mode` flag and the
 * environment. An explicit `--output-mode` wins; otherwise the precedence is
 * `FORCE_COLOR` > `PRE_COMMIT` > GitHub Actions > whether stderr is a TTY.
 * `FORCE_COLOR` forces the spinner even with no TTY (a CI that captures a
 * terminal); pre-commit hooks default to JSON because pre-commit captures hook
 * output even when stderr is a TTY; a GitHub Actions runner gets workflow-command
 * output. Colour saturation is a separate axis, chosen by `--colour`/`--no-colour`
 * and `NO_COLOR`; it does not select the mode here.
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
