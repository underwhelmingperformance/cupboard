import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = new URL(
	'../actions/prepare/free-disk-space.sh',
	import.meta.url
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

// The script leaves its globs unquoted, so bash replaces them with the paths
// that exist on the machine. Expand them the same way for the expected log.
async function expanded(pattern: string): Promise<string> {
	const { stdout } = await execFileAsync('bash', [
		'-c',
		'echo $1',
		'expand',
		pattern
	]);

	return stdout.trimEnd();
}

async function stub(directory: string, name: string, body: string) {
	const file = path.join(directory, name);

	await writeFile(file, `#!/bin/sh\n${body}\n`);
	await chmod(file, 0o755);
}

it.each([
	{ name: 'succeeds', sudoStatus: 0, status: '0\n', commandCount: 7 },
	{ name: 'fails', sudoStatus: 7, status: '7\n', commandCount: 3 }
])(
	'writes the exit status to the pipe when the removal $name',
	async ({ sudoStatus, status, commandCount }) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-free-'));
		const bin = path.join(directory, 'bin');
		const home = path.join(directory, 'home');
		const pipe = path.join(directory, 'status.fifo');
		const log = path.join(directory, 'output.log');

		temporaryDirectories.push(directory);
		await mkdir(bin);
		await mkdir(home);
		await stub(bin, 'df', 'echo "df $*"');
		await stub(bin, 'xcrun', 'echo "xcrun $*"');
		await stub(bin, 'sudo', `echo "sudo $*"\nexit ${String(sudoStatus)}`);
		await execFileAsync('mkfifo', [pipe]);
		await writeFile(log, 'launcher output\n');

		const child = spawn('bash', [fileURLToPath(script), pipe, log], {
			env: {
				...process.env,
				HOME: home,
				PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
			},
			stdio: 'ignore'
		});
		const exited = once(child, 'close');

		// Opening the pipe for writing completes when this test reads it.
		const reported = await readFile(pipe, 'utf8');

		await exited;

		const commands = [
			'df -h /',
			'sudo xcode-select --switch /Library/Developer/CommandLineTools',
			`sudo rm -rf ${await expanded('/Applications/Xcode_*.app')}`,
			`sudo rm -rf ${await expanded('/Library/Developer/CoreSimulator/Profiles/Runtimes/*')}`,
			`sudo rm -rf ${home}/Library/Developer/CoreSimulator/Caches/*`,
			'xcrun simctl delete unavailable',
			'df -h /'
		];

		expect({ reported, log: await readFile(log, 'utf8') }).toStrictEqual({
			reported: status,
			log: `launcher output\n${commands.slice(0, commandCount).join('\n')}\n`
		});
	}
);
