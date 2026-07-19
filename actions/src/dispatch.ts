import { env } from 'node:process';

import { attestAction } from './commands/attest.ts';
import { pushAction } from './commands/push.ts';
import { setupAction } from './commands/setup.ts';
import { UnknownCommandError } from './errors.ts';
import type { Environment } from './inputs.ts';

export async function dispatch(
	command: string | undefined,
	environment: Environment = env
): Promise<void> {
	if (command === 'setup') {
		return setupAction(environment);
	}

	if (command === 'push') {
		return pushAction(environment);
	}

	if (command === 'attest') {
		return attestAction(environment);
	}

	throw new UnknownCommandError(command ?? '');
}
