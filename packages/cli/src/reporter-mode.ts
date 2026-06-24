import { env, stderr } from 'node:process';

import type { ReporterMode } from '@cupboard/reporter';

/**
 * Resolve a CLI's reporter mode from its `--output-mode` flag and the
 * environment. An explicit `--output-mode` wins; otherwise the precedence is
 * `FORCE_COLOR` > `PRE_COMMIT` > whether stderr is a TTY. `FORCE_COLOR` forces
 * the spinner even with no TTY (a CI that captures a terminal); pre-commit hooks
 * default to JSON because pre-commit captures hook output even when stderr is a
 * TTY. Colour saturation is a separate axis, chosen by `--colour`/`--no-colour`
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

	return stderr.isTTY ? 'terminal' : 'json';
}
