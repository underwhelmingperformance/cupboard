import { env, stderr } from 'node:process';

import type { ReporterMode } from '@cupboard/reporter';

/**
 * Resolve a CLI's reporter mode from its `--colour` flag. `--colour` forces the
 * spinner, `--no-colour` forces line-delimited JSON, and pre-commit hooks
 * default to JSON because pre-commit captures hook output even when stderr is a
 * TTY. With none of those signals the mode follows whether stderr is a TTY.
 */
export function resolveReporterMode(colour?: boolean): ReporterMode {
	if (colour !== undefined) {
		return colour ? 'terminal' : 'json';
	}

	if (env.PRE_COMMIT === '1') {
		return 'json';
	}

	return stderr.isTTY ? 'terminal' : 'json';
}
