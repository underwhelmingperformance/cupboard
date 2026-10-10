import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { renderActionBundle } from './action-bundles.ts';

const execute = promisify(execFile);

it('bundles TypeScript dependencies reproducibly without runtime installation', async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-action-bundle-')
	);
	const sourcePath = path.join(directory, 'main.ts');
	const outputPath = path.join(directory, 'main.cjs');

	try {
		await writeFile(
			path.join(directory, 'value.ts'),
			'export const value: string = "bundled";\n'
		);
		await writeFile(
			sourcePath,
			'import { value } from "./value.ts";\nprocess.stdout.write(value);\n'
		);
		const contents = await renderActionBundle(sourcePath);
		await writeFile(outputPath, contents);
		await rm(sourcePath);
		await rm(path.join(directory, 'value.ts'));
		const result = await execute(process.execPath, [outputPath], {
			cwd: directory
		});
		expect({
			stdout: result.stdout,
			stderr: result.stderr,
			bundle: await readFile(outputPath, 'utf8')
		}).toStrictEqual({ stdout: 'bundled', stderr: '', bundle: contents });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it('produces identical bundles when called again', async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-action-bundle-')
	);
	const sourcePath = path.join(directory, 'post.ts');

	try {
		await writeFile(
			sourcePath,
			'const value: string = "cleanup";\nprocess.stdout.write(value);\n'
		);
		expect(await renderActionBundle(sourcePath)).toBe(
			await renderActionBundle(sourcePath)
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([false, true])(
	'runs both manifest bundles without a source checkout or runtime installation, with a read session=%s',
	async (privateRead) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-evaluation-bundle-')
		);
		const actionSource = path.join(
			import.meta.dirname,
			'..',
			'actions',
			'src',
			'evaluate-targets'
		);
		const raw = Array.from({ length: 6 }, (_, index) => ({
			attr: `.#package${String(index)}`,
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			rootSuffix: `/package${String(index)}/`
		}));
		const main = path.join(directory, 'main.cjs');
		const worker = path.join(directory, 'worker.cjs');
		const calls = path.join(directory, 'calls.jsonl');
		const output = path.join(directory, 'output');
		const cupboard = path.join(directory, 'cupboard');
		try {
			await writeFile(
				main,
				await renderActionBundle(path.join(actionSource, 'main.ts'))
			);
			await writeFile(
				worker,
				await renderActionBundle(path.join(actionSource, 'worker.ts'))
			);
			await writeFile(
				path.join(directory, 'nix'),
				String.raw`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify({ kind:'nix',args })+'\n');const raw=${JSON.stringify(raw)};const expression=args.at(-1);process.stdout.write(expression==='builtins.length'?'6':JSON.stringify(raw[Number(expression.match(/builtins\.elemAt targets (\d+)/)[1])]));
`,
				{ mode: 0o700 }
			);
			await writeFile(
				cupboard,
				String.raw`#!${process.execPath}
const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify({ kind:'wrapper',args })+'\n');const split=args.indexOf('--');const result=cp.spawnSync(args[split+1],args.slice(split+2),{stdio:'inherit',env:process.env});process.exitCode=result.status??1;
`,
				{ mode: 0o700 }
			);
			const result = await execute(process.execPath, [main], {
				cwd: directory,
				env: {
					...process.env,
					PATH: directory + path.delimiter + (process.env.PATH ?? ''),
					CALLS: calls,
					INPUT_TARGETS: '.#targets',
					INPUT_PUBLISH: 'none',
					GITHUB_OUTPUT: output,
					'INPUT_CUPBOARD-PATH': cupboard,
					'INPUT_READ-SESSION-TARGET': privateRead
						? 'https://cupboard.example.workers.dev/t/acme/cache/builds'
						: '',
					INPUT_AUDIENCE: ' audience ',
					'INPUT_READ-SESSION-CACHES': '[]'
				}
			});
			const callContents = await readFile(calls, 'utf8');
			const observed: unknown[] = callContents
				.trim()
				.split('\n')
				.map((line: string): unknown => JSON.parse(line));
			expect({
				result,
				output: await readFile(output, 'utf8'),
				calls: observed.toSorted((left, right) =>
					JSON.stringify(left).localeCompare(JSON.stringify(right))
				)
			}).toStrictEqual({
				result: { stdout: '', stderr: '' },
				output: `manifest=${JSON.stringify(raw)}\n`,
				calls: [
					...Array.from({ length: 6 }, (_, index) => ({
						kind: 'nix',
						args: [
							'eval',
							'--json',
							'.#targets',
							'--apply',
							`targets: builtins.removeAttrs (builtins.elemAt targets ${String(index)}) [ "rootDrvPath" ]`
						]
					})),
					{
						kind: 'nix',
						args: ['eval', '--json', '.#targets', '--apply', 'builtins.length']
					},
					...(privateRead
						? [
								{
									kind: 'wrapper',
									args: [
										'run',
										'https://cupboard.example.workers.dev/t/acme/cache/builds',
										'--github-oidc',
										'--audience',
										'audience',
										'--',
										process.execPath,
										worker
									]
								}
							]
						: [])
				].toSorted((left, right) =>
					JSON.stringify(left).localeCompare(JSON.stringify(right))
				)
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);
