import { env, stderr } from 'node:process';

import type { ReporterMode } from '@cupboard/reporter';

/**
 * Resolve a CLI's reporter mode from its `--colour` flag and the environment.
 * The precedence is `--colour`/`--no-colour` > `FORCE_COLOR` > `PRE_COMMIT` >
 * whether stderr is a TTY: `--colour` forces the spinner and `--no-colour`
 * forces line-delimited JSON; `FORCE_COLOR` forces the spinner even with no TTY
 * (a CI that captures a terminal); pre-commit hooks default to JSON because
 * pre-commit captures hook output even when stderr is a TTY. `NO_COLOR` does not
 * appear here: it desaturates the terminal output (picocolors honours it) rather
 * than switching to JSON.
 */
export function resolveReporterMode(colour?: boolean): ReporterMode {
	if (colour !== undefined) {
		return colour ? 'terminal' : 'json';
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
