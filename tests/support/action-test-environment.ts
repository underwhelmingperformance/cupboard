import process from 'node:process';

import { beforeEach } from 'vitest';

function resetActionEnvironment(): void {
	delete process.env.GITHUB_ACTIONS;
	delete process.env.CUPBOARD_LOG_DIRECTORY;
}

resetActionEnvironment();
beforeEach(resetActionEnvironment);
