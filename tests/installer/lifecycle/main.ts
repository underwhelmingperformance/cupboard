import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = await mkdtemp(
	path.join(process.env.RUNNER_TEMP ?? '/tmp', 'builder-lifecycle-')
);
const environmentFile = process.env.GITHUB_ENV;
const stateFile = process.env.GITHUB_STATE;
if (environmentFile === undefined || stateFile === undefined) {
	throw new Error('GitHub action command files are required');
}
const configurationRoot =
	process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config');
const original = {
	NIX_CONFIG: process.env.NIX_CONFIG ?? '',
	NIX_USER_CONF_FILES:
		process.env.NIX_USER_CONF_FILES ??
		path.join(configurationRoot, 'nix', 'nix.conf'),
	NIX_SSHOPTS: process.env.NIX_SSHOPTS ?? ''
};
for (const [key, value] of Object.entries(original)) {
	await writeFile(path.join(directory, key), value);
}
await appendFile(environmentFile, `TRIAL_LIFECYCLE_DIRECTORY=${directory}\n`);
await appendFile(stateFile, `directory=${directory}\n`);
