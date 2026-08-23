import { env, stderr } from 'node:process';

import type { ReporterMode } from '@cupboard/reporter';
import { isGithubActions } from '@cupboard/shared/github-actions';

/**
 * Resolves a CLI's reporter mode from its `--output-mode` flag and the
 * environment. An explicit `--output-mode` wins; otherwise the precedence is
 * `FORCE_COLOR` > `PRE_COMMIT` > GitHub Actions > whether stderr is a TTY.
 * `FORCE_COLOR` selects terminal rendering even without a TTY. This does not
 * make prompts interactive; `createCliUi` checks stream eligibility and Clack's
 * CI signal separately. Pre-commit uses JSON because it captures hook
 * output even when stderr is a TTY. `GITHUB_ACTIONS=true` selects GitHub output.
 * Colour flags and `NO_COLOR` configure colour but do not select the mode.
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
