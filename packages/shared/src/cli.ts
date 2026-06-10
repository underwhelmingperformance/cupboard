import { stderr } from 'node:process';

import type { ReporterMode } from '@cupboard/reporter';

/**
 * Resolve a CLI's reporter mode from its `--colour` flag. `--colour` forces the
 * spinner, `--no-colour` forces line-delimited JSON, and with neither the mode
 * follows whether stderr is a TTY.
 */
export function resolveReporterMode(colour: boolean | undefined): ReporterMode {
	if (colour !== undefined) {
		return colour ? 'terminal' : 'json';
	}

	return stderr.isTTY ? 'terminal' : 'json';
}
