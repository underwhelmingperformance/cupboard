import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { CodedError } from '@cupboard/shared/errors';
import type { RootContent } from 'mdast';
import { type CompileContext, fromMarkdown } from 'mdast-util-from-markdown';

export interface PublishedReleaseTag {
	readonly tagName: string;
	readonly draft: boolean;
	readonly prerelease?: boolean;
}

export interface ReleaseUpgradeFragment {
	readonly path: string;
	readonly body: string;
}

export interface ReleaseUpgradeOptions {
	readonly directory: string;
	readonly commitish: string;
	readonly version: string;
	readonly releases: readonly PublishedReleaseTag[];
	readonly repository: { readonly owner: string; readonly repo: string };
}

const execute = promisify(execFile);
const notesDirectory = 'docs/operator/upgrade-notes/';
const canonicalVersion = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const sectionStart = '<!-- cupboard:upgrade-notes:start -->';
const sectionEnd = '<!-- cupboard:upgrade-notes:end -->';

export class ReleaseUpgradeNotesError extends CodedError {
	constructor(detail: string, options?: ErrorOptions) {
		super(`Could not collect release upgrade guidance: ${detail}`, options);
		this.name = 'ReleaseUpgradeNotesError';
	}
}

async function git(
	directory: string,
	arguments_: readonly string[]
): Promise<string> {
	try {
		const result = await execute('git', ['-C', directory, ...arguments_], {
			maxBuffer: 4 * 1024 * 1024
		});
		return result.stdout;
	} catch (error) {
		throw new ReleaseUpgradeNotesError(
			'Git could not read the release history or upgrade fragments',
			{ cause: error }
		);
	}
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.slice(1).split('.').map(BigInt);
	const rightParts = right.slice(1).split('.').map(BigInt);
	for (let index = 0; index < 3; index += 1) {
		const a = leftParts[index];
		const b = rightParts[index];
		if (a !== undefined && b !== undefined && a !== b) {
			return a > b ? 1 : -1;
		}
	}
	return 0;
}

async function resolveCommit(
	directory: string,
	reference: string
): Promise<string> {
	const result = await git(directory, [
		'rev-parse',
		'--verify',
		'--end-of-options',
		reference.concat('^{commit}')
	]);
	return result.trim();
}

async function isAncestor(
	directory: string,
	baseline: string,
	target: string
): Promise<boolean> {
	try {
		await execute(
			'git',
			['-C', directory, 'merge-base', '--is-ancestor', baseline, target],
			{ maxBuffer: 1024 }
		);
		return true;
	} catch (error) {
		if (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 1
		) {
			return false;
		}
		throw new ReleaseUpgradeNotesError(
			'Git could not compare release ancestry',
			{ cause: error }
		);
	}
}

async function precedingRelease(
	options: ReleaseUpgradeOptions,
	target: string
): Promise<string | undefined> {
	const candidates = options.releases
		.filter(
			(release) =>
				!release.draft &&
				canonicalVersion.test(release.tagName) &&
				compareVersions(release.tagName, options.version) < 0
		)
		.toSorted((left, right) => compareVersions(right.tagName, left.tagName));
	for (const release of candidates) {
		const commit = await resolveCommit(
			options.directory,
			`refs/tags/${release.tagName}`
		);
		if (await isAncestor(options.directory, commit, target)) {
			return commit;
		}
	}
	return undefined;
}

function sourceUrl(
	destination: string,
	source: string,
	options: ReleaseUpgradeOptions
): string {
	if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(destination)) {
		return destination;
	}
	const { owner, repo } = options.repository;
	const base = `https://github.com/${owner}/${repo}/blob/${options.version}/`;
	return new URL(
		destination.startsWith('/') ? destination.slice(1) : destination,
		destination.startsWith('/') ? base : `${base}${source}`
	).href;
}

interface MarkdownEdit {
	readonly start: number;
	readonly end: number;
	readonly value: string;
}

interface MarkdownSpan {
	readonly start: number;
	readonly end: number;
}

function resolveLinks(
	body: string,
	source: string,
	options: ReleaseUpgradeOptions
): string {
	const spans = new WeakMap<object, Map<string, MarkdownSpan>>();
	const tree = fromMarkdown(body, {
		mdastExtensions: [
			{
				beforeEnter(this: CompileContext, token) {
					if (
						![
							'label',
							'definitionLabelString',
							'definitionDestination',
							'resourceDestination',
							'resource'
						].includes(token.type)
					) {
						return;
					}
					const node = this.stack.at(-1);
					if (node === undefined) {
						return;
					}
					const positions = spans.get(node) ?? new Map<string, MarkdownSpan>();
					positions.set(token.type, {
						start: token.start.offset,
						end: token.end.offset
					});
					spans.set(node, positions);
				}
			}
		]
	});
	const position = (node: RootContent, token: string): MarkdownSpan => {
		const span = spans.get(node)?.get(token);
		if (span === undefined) {
			throw new ReleaseUpgradeNotesError(
				'Markdown link positions could not be resolved'
			);
		}
		return span;
	};
	const edits: MarkdownEdit[] = [];
	const scopedIdentifier = (identifier: string) =>
		`cupboard-upgrade-${createHash('sha256').update(`${source}\0${identifier}`).digest('hex')}`;
	const visit = (node: RootContent): void => {
		switch (node.type) {
			case 'definition': {
				edits.push(
					{
						...position(node, 'definitionLabelString'),
						value: scopedIdentifier(node.identifier)
					},
					{
						...position(node, 'definitionDestination'),
						value: `<${sourceUrl(node.url, source, options)}>`
					}
				);
				break;
			}
			case 'linkReference':
			case 'imageReference': {
				const end = node.position?.end.offset;
				if (end === undefined) {
					throw new ReleaseUpgradeNotesError(
						'Markdown reference positions could not be resolved'
					);
				}
				edits.push({
					start: position(node, 'label').end,
					end,
					value: `[${scopedIdentifier(node.identifier)}]`
				});
				break;
			}
			case 'link':
			case 'image': {
				if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(node.url)) {
					break;
				}
				const insertion = position(node, 'resource').start + 1;
				const destination = spans.get(node)?.get('resourceDestination') ?? {
					start: insertion,
					end: insertion
				};
				edits.push({
					...destination,
					value: `<${sourceUrl(node.url, source, options)}>`
				});
				break;
			}
		}
		if ('children' in node) {
			for (const child of node.children) {
				visit(child);
			}
		}
	};
	for (const node of tree.children) {
		visit(node);
	}
	let resolved = body;
	const orderedEdits = edits.toSorted(
		(left, right) => right.start - left.start
	);
	for (const edit of orderedEdits) {
		resolved =
			resolved.slice(0, edit.start) + edit.value + resolved.slice(edit.end);
	}
	return resolved;
}

export async function collectReleaseUpgradeNotes(
	options: ReleaseUpgradeOptions
): Promise<readonly ReleaseUpgradeFragment[]> {
	const target = await resolveCommit(options.directory, options.commitish);
	const baseline = await precedingRelease(options, target);
	const output = await git(
		options.directory,
		baseline === undefined
			? ['ls-tree', '-rz', '--name-only', target, '--', notesDirectory]
			: [
					'diff',
					'--name-only',
					'--no-renames',
					'--diff-filter=AM',
					'-z',
					baseline,
					target,
					'--',
					notesDirectory
				]
	);
	const paths = output
		.split('\0')
		.filter((file) => file.startsWith(notesDirectory) && file.endsWith('.md'))
		.toSorted((left, right) => (left < right ? -1 : Number(left > right)));
	const fragments: ReleaseUpgradeFragment[] = [];
	for (const file of paths) {
		const body = await git(options.directory, ['show', `${target}:${file}`]);
		fragments.push({ path: file, body: resolveLinks(body, file, options) });
	}
	return fragments;
}

export function replaceReleaseUpgradeNotes(
	body: string,
	notes: readonly ReleaseUpgradeFragment[]
): string {
	if (
		notes.some(
			(note) =>
				note.body.includes(sectionStart) || note.body.includes(sectionEnd)
		)
	) {
		throw new ReleaseUpgradeNotesError(
			'a fragment contains reserved upgrade guidance markers'
		);
	}
	const guidance =
		notes.length === 0
			? 'No additional upgrade steps are required for this release.'
			: notes.map((note) => note.body.trim()).join('\n\n');
	const section = `${sectionStart}\n## Upgrade guidance\n\n${guidance}\n${sectionEnd}`;
	const start = body.indexOf(sectionStart);
	const end = body.indexOf(sectionEnd);
	if (start === -1 && end === -1) {
		return `${body}${body === '' ? '' : '\n\n'}${section}`;
	}
	if (
		start === -1 ||
		end < start ||
		body.includes(sectionStart, start + 1) ||
		body.includes(sectionEnd, end + 1)
	) {
		throw new ReleaseUpgradeNotesError(
			'the draft has malformed or repeated upgrade guidance markers'
		);
	}
	return body.slice(0, start) + section + body.slice(end + sectionEnd.length);
}
