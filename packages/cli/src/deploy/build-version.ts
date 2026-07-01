import { execFile } from 'node:child_process';
import { env } from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The version stamped into a build. `CUPBOARD_BUILD_VERSION` wins when set, so a
 * build without a Git checkout (such as a Nix flake working from an exported
 * source tree) can supply the revision itself. Otherwise it is the short Git
 * revision, suffixed `+dirty` when the working tree has uncommitted changes.
 */
export async function resolveBuildVersion(
	checkoutRoot: string
): Promise<string> {
	const override = env.CUPBOARD_BUILD_VERSION?.trim();

	if (override !== undefined && override !== '') {
		return override;
	}

	const revision = await gitOutput(checkoutRoot, [
		'rev-parse',
		'--short=12',
		'HEAD'
	]);
	const status = await gitOutput(checkoutRoot, ['status', '--porcelain']);

	return status === '' ? revision : `${revision}+dirty`;
}

async function gitOutput(
	cwd: string,
	arguments_: readonly string[]
): Promise<string> {
	const { stdout } = await execFileAsync('git', [...arguments_], { cwd });

	return stdout.trim();
}
