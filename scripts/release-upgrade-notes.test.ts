import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import {
	collectReleaseUpgradeNotes,
	replaceReleaseUpgradeNotes
} from './release-upgrade-notes.ts';

const execute = promisify(execFile);
const repository = { owner: 'acme', repo: 'app' };
const prefix = 'docs/operator/upgrade-notes/';

async function fixture() {
	const directory = await mkdtemp(path.join(tmpdir(), 'release-upgrades-'));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const git = async (...arguments_: string[]) => {
		const result = await execute('git', arguments_, { cwd: directory });
		return result.stdout.trim();
	};
	await git('init', '--initial-branch=main');
	await git('config', 'user.email', 'test@example.com');
	await git('config', 'user.name', 'Release fixture');
	await git('config', 'commit.gpgsign', 'false');
	await git('config', 'tag.gpgsign', 'false');
	// `git commit` can start a background repack, which moves loose objects
	// into a pack while a test reads or deletes them.
	await git('config', 'maintenance.auto', 'false');
	await mkdir(path.join(directory, prefix), { recursive: true });
	const note = (name: string, body: string) =>
		writeFile(path.join(directory, prefix, name), body);
	const commit = async () => {
		await git('add', '--all');
		await git('commit', '--allow-empty', '-qm', 'fixture');
		return git('rev-parse', 'HEAD');
	};
	return { directory, git, note, commit };
}

it('reads all first-release fragments from the exact commit, with release-tag links', async () => {
	const { directory, note, commit } = await fixture();
	await note(
		'schema.md',
		'# Schema upgrade\n\nRead [the guide](../upgrading.md#deploy) and [details][details].\n\n[details]: ../../reference/cli.md\n'
	);
	const commitish = await commit();
	await note('schema.md', 'Uncommitted replacement');
	await note('untracked.md', 'Untracked guidance');
	const fragments = await collectReleaseUpgradeNotes({
		directory,
		commitish,
		version: 'v1.0.0',
		releases: [],
		repository
	});
	expect(
		fragments.map((fragment) => ({
			...fragment,
			body: fragment.body.replaceAll(
				/cupboard-upgrade-[a-f\d]+/gu,
				'cupboard-upgrade-scoped'
			)
		}))
	).toStrictEqual([
		{
			path: `${prefix}schema.md`,
			body: '# Schema upgrade\n\nRead [the guide](<https://github.com/acme/app/blob/v1.0.0/docs/operator/upgrading.md#deploy>) and [details][cupboard-upgrade-scoped].\n\n[cupboard-upgrade-scoped]: <https://github.com/acme/app/blob/v1.0.0/docs/reference/cli.md>\n'
		}
	]);
});

it('includes added and modified fragments, excluding unchanged and deleted guidance', async () => {
	const { directory, git, note, commit } = await fixture();
	await note('modified.md', 'Old guidance');
	await note('unchanged.md', 'Unchanged guidance');
	await note('deleted.md', 'Deleted guidance');
	await commit();
	await git('tag', 'v1.0.0');
	await note('modified.md', 'Current guidance');
	await note('added.md', 'New guidance');
	await rm(path.join(directory, prefix, 'deleted.md'));
	const commitish = await commit();
	expect(
		await collectReleaseUpgradeNotes({
			directory,
			commitish,
			version: 'v1.1.0',
			releases: [{ tagName: 'v1.0.0', draft: false }],
			repository
		})
	).toStrictEqual([
		{ path: `${prefix}added.md`, body: 'New guidance' },
		{ path: `${prefix}modified.md`, body: 'Current guidance' }
	]);
});

it('resolves multiline, collapsed and shortcut references independently in each fragment, preserving code', async () => {
	const { directory, note, commit } = await fixture();
	const example =
		'`[guide](../example.md)`\n\n    [guide](../indented.md)\n\n```md\n[guide](../fenced.md)\n```\n';
	await note(
		'first.md',
		`[Guide][shared], [shared][] and [shared].\n\n[shared]:\n  ../upgrading.md#deploy "Upgrade guide"\n\n${example}`
	);
	await note(
		'second.md',
		'[shared] and ![image](../../images/upgrade.png).\n\n[shared]: ../../reference/cli.md\n'
	);
	const commitish = await commit();
	const fragments = await collectReleaseUpgradeNotes({
		directory,
		commitish,
		version: 'v1.0.0',
		releases: [],
		repository
	});
	expect(
		fragments.map((fragment) => ({
			path: fragment.path,
			body: fragment.body.replaceAll(/cupboard-upgrade-[a-f\d]+/gu, 'scoped')
		}))
	).toStrictEqual([
		{
			path: `${prefix}first.md`,
			body: `[Guide][scoped], [shared][scoped] and [shared][scoped].\n\n[scoped]:\n  <https://github.com/acme/app/blob/v1.0.0/docs/operator/upgrading.md#deploy> "Upgrade guide"\n\n${example}`
		},
		{
			path: `${prefix}second.md`,
			body: '[shared][scoped] and ![image](<https://github.com/acme/app/blob/v1.0.0/docs/images/upgrade.png>).\n\n[scoped]: <https://github.com/acme/app/blob/v1.0.0/docs/reference/cli.md>\n'
		}
	]);
	expect(fragments[0]?.body.match(/cupboard-upgrade-[a-f\d]+/u)?.[0]).not.toBe(
		fragments[1]?.body.match(/cupboard-upgrade-[a-f\d]+/u)?.[0]
	);
});

it('preserves quoted Markdown layout and destinations with balanced parentheses or angle brackets', async () => {
	const { directory, note, commit } = await fixture();
	await note(
		'quoted.md',
		'> [Guide][guide]\n>\n> [guide]:\n>   ../upgrading.md "Title"\n\nRead [nested](../guide(one).md "Title") and [spaces](<../guide two.md>).\n'
	);
	const commitish = await commit();
	const fragments = await collectReleaseUpgradeNotes({
		directory,
		commitish,
		version: 'v1.0.0',
		releases: [],
		repository
	});
	expect(
		fragments.map((fragment) => ({
			...fragment,
			body: fragment.body.replaceAll(/cupboard-upgrade-[a-f\d]+/gu, 'scoped')
		}))
	).toStrictEqual([
		{
			path: `${prefix}quoted.md`,
			body: '> [Guide][scoped]\n>\n> [scoped]:\n>   <https://github.com/acme/app/blob/v1.0.0/docs/operator/upgrading.md> "Title"\n\nRead [nested](<https://github.com/acme/app/blob/v1.0.0/docs/operator/guide(one).md> "Title") and [spaces](<https://github.com/acme/app/blob/v1.0.0/docs/operator/guide%20two.md>).\n'
		}
	]);
});

it('resolves valid empty destinations to the tagged fragment', async () => {
	const { directory, note, commit } = await fixture();
	await note(
		'empty.md',
		'[Current source]() and [definition].\n\n[definition]: <>\n'
	);
	const commitish = await commit();
	const fragments = await collectReleaseUpgradeNotes({
		directory,
		commitish,
		version: 'v1.0.0',
		releases: [],
		repository
	});
	expect(
		fragments.map((fragment) => ({
			...fragment,
			body: fragment.body.replaceAll(/cupboard-upgrade-[a-f\d]+/gu, 'scoped')
		}))
	).toStrictEqual([
		{
			path: `${prefix}empty.md`,
			body: '[Current source](<https://github.com/acme/app/blob/v1.0.0/docs/operator/upgrade-notes/empty.md>) and [definition][scoped].\n\n[scoped]: <https://github.com/acme/app/blob/v1.0.0/docs/operator/upgrade-notes/empty.md>\n'
		}
	]);
});

it('selects the latest preceding published canonical release on target ancestry, including prereleases', async () => {
	const { directory, git, note, commit } = await fixture();
	await note('first.md', 'First guidance');
	await commit();
	await git('tag', 'v1.0.0');
	await note('preceding.md', 'Earlier prerelease guidance');
	await commit();
	await git('tag', 'v1.1.0');
	await note('current.md', 'Current guidance');
	const commitish = await commit();
	await git('checkout', '--orphan', 'other');
	await git('rm', '-rf', '.');
	await commit();
	await git('tag', 'v1.9.0');
	expect(
		await collectReleaseUpgradeNotes({
			directory,
			commitish,
			version: 'v2.0.0',
			releases: [
				{ tagName: 'v2.1.0', draft: false },
				{ tagName: 'v2.0.0', draft: false },
				{ tagName: 'v1.8.0', draft: true },
				{ tagName: 'not-a-version', draft: false },
				{ tagName: 'v1.9.0', draft: false },
				{ tagName: 'v1.0.0', draft: false },
				{ tagName: 'v1.1.0', draft: false, prerelease: true }
			],
			repository
		})
	).toStrictEqual([{ path: `${prefix}current.md`, body: 'Current guidance' }]);
});

it.each(['missing target', 'missing published tag'] as const)(
	'fails when %s Git metadata is unavailable',
	async (kind) => {
		const { directory, note, commit } = await fixture();
		await note('first.md', 'Guidance');
		const commitish = await commit();
		await expect(
			collectReleaseUpgradeNotes({
				directory,
				commitish: kind === 'missing target' ? 'missing' : commitish,
				version: 'v1.1.0',
				releases:
					kind === 'missing published tag'
						? [{ tagName: 'v1.0.0', draft: false }]
						: [],
				repository
			})
		).rejects.toThrow();
	}
);

it('fails when a committed fragment cannot be read', async () => {
	const { directory, git, note, commit } = await fixture();
	await note('schema.md', 'Guidance');
	const commitish = await commit();
	const object = await git('rev-parse', `${commitish}:${prefix}schema.md`);
	await rm(
		path.join(directory, '.git/objects', object.slice(0, 2), object.slice(2))
	);
	await expect(
		collectReleaseUpgradeNotes({
			directory,
			commitish,
			version: 'v1.0.0',
			releases: [],
			repository
		})
	).rejects.toThrow('Git could not read');
});

it.each([
	'<!-- cupboard:upgrade-notes:start -->',
	'<!-- cupboard:upgrade-notes:end -->',
	'<!-- cupboard:upgrade-notes:end --><!-- cupboard:upgrade-notes:start -->',
	'<!-- cupboard:upgrade-notes:start --><!-- cupboard:upgrade-notes:start --><!-- cupboard:upgrade-notes:end -->'
])('rejects malformed draft guidance markers: %s', (body) => {
	expect(() => replaceReleaseUpgradeNotes(body, [])).toThrow(
		'malformed or repeated'
	);
});

it('rejects fragments containing owned section markers', () => {
	expect(() =>
		replaceReleaseUpgradeNotes('', [
			{ path: `${prefix}bad.md`, body: '<!-- cupboard:upgrade-notes:end -->' }
		])
	).toThrow('reserved upgrade guidance markers');
});

it('replaces only owned guidance on retry and removes stale guidance when notes disappear', () => {
	const first = replaceReleaseUpgradeNotes(
		'Maintainer introduction.\n\nGenerated release notes.\n',
		[{ path: `${prefix}first.md`, body: 'Old upgrade guidance.' }]
	);
	const edited = `${first}\nMaintainer follow-up.`;
	const updated = replaceReleaseUpgradeNotes(edited, [
		{ path: `${prefix}second.md`, body: 'New upgrade guidance.' }
	]);
	expect({
		updated,
		repeated: replaceReleaseUpgradeNotes(updated, [
			{ path: `${prefix}second.md`, body: 'New upgrade guidance.' }
		]),
		empty: replaceReleaseUpgradeNotes(updated, [])
	}).toStrictEqual({
		updated:
			'Maintainer introduction.\n\nGenerated release notes.\n\n\n<!-- cupboard:upgrade-notes:start -->\n## Upgrade guidance\n\nNew upgrade guidance.\n<!-- cupboard:upgrade-notes:end -->\nMaintainer follow-up.',
		repeated: updated,
		empty:
			'Maintainer introduction.\n\nGenerated release notes.\n\n\n<!-- cupboard:upgrade-notes:start -->\n## Upgrade guidance\n\nNo additional upgrade steps are required for this release.\n<!-- cupboard:upgrade-notes:end -->\nMaintainer follow-up.'
	});
});
