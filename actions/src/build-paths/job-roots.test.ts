import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	createJobRoots,
	jobRootsStateKey,
	removeJobRoots
} from './job-roots.ts';

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function fixture() {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-job-roots-test-')
	);
	temporaryDirectories.push(directory);
	return {
		RUNNER_TEMP: directory,
		GITHUB_STATE: path.join(directory, 'github-state')
	};
}

describe('job roots', () => {
	it('records separate owner-only invocation directories for post cleanup', async () => {
		const environment = await fixture();
		const first = await createJobRoots(environment);
		const second = await createJobRoots(environment);
		const firstStat = await stat(first);
		const firstMode = firstStat.mode & 0o777;
		const secondStat = await stat(second);
		const secondMode = secondStat.mode & 0o777;
		expect({
			distinct: first !== second,
			modes: [firstMode, secondMode],
			state: await readFile(environment.GITHUB_STATE, 'utf8')
		}).toStrictEqual({
			distinct: true,
			modes: [0o700, 0o700],
			state: `${jobRootsStateKey}=${first}\n${jobRootsStateKey}=${second}\n`
		});
		const postEnvironment = {
			...environment,
			[`STATE_${jobRootsStateKey}`]: first
		};
		await removeJobRoots(postEnvironment);
		await removeJobRoots(postEnvironment);
		await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
		const survivingStat = await stat(second);
		expect(survivingStat.isDirectory()).toBe(true);
	});

	it.each(['', 'other-job', '../another-job'])(
		'does not remove unrelated directories for state %s',
		async (state) => {
			const environment = await fixture();
			const unrelated = path.join(environment.RUNNER_TEMP, 'other-job');
			await mkdir(unrelated);
			await writeFile(path.join(unrelated, 'output'), 'keep');
			const post = removeJobRoots({
				...environment,
				[`STATE_${jobRootsStateKey}`]:
					state === '' ? '' : path.join(environment.RUNNER_TEMP, state)
			});
			if (state === '') {
				await post;
			}
			if (state !== '') {
				await expect(post).rejects.toThrow(
					'invocation directory beneath RUNNER_TEMP'
				);
			}
			expect(await readFile(path.join(unrelated, 'output'), 'utf8')).toBe(
				'keep'
			);
		}
	);
});
