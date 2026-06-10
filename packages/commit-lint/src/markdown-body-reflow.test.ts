import { describe, expect, it } from 'vitest';

import {
	MarkdownBodyReflow,
	MarkdownBodyReflower
} from './markdown-body-reflow.ts';
import { CommitMessageDocument } from './message.ts';

describe('CommitMessageDocument', () => {
	it('splits prose from git trailers', () => {
		const document = CommitMessageDocument.parse(
			[
				'feat: add collaboration',
				'',
				'Explain the change.',
				'',
				'Co-authored-by: Alice Example <alice@example.com>',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
			].join('\n')
		);

		expect(documentFields(document)).toStrictEqual({
			body: 'Explain the change.\n',
			separatorMissing: false,
			subject: 'feat: add collaboration',
			trailers: [
				'Co-authored-by: Alice Example <alice@example.com>',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
			]
		});
	});

	it('treats unknown trailer-like final blocks as git trailers', () => {
		const document = CommitMessageDocument.parse(
			[
				'docs: explain external issue',
				'',
				'Explain the change.',
				'',
				'Issue: PROJECT-123',
				'Reviewed-on: https://example.com/review/123'
			].join('\n')
		);

		expect(documentFields(document)).toStrictEqual({
			body: 'Explain the change.\n',
			separatorMissing: false,
			subject: 'docs: explain external issue',
			trailers: [
				'Issue: PROJECT-123',
				'Reviewed-on: https://example.com/review/123'
			]
		});
	});

	it('recognises a cherry-pick line as part of a trailer block', () => {
		const document = CommitMessageDocument.parse(
			[
				'fix: thing',
				'',
				'Explain the change.',
				'',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>',
				'(cherry picked from commit abc1234567)'
			].join('\n')
		);

		expect(documentFields(document)).toStrictEqual({
			body: 'Explain the change.\n',
			separatorMissing: false,
			subject: 'fix: thing',
			trailers: [
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>',
				'(cherry picked from commit abc1234567)'
			]
		});
	});

	it('keeps mixed final blocks in the prose body', () => {
		const document = CommitMessageDocument.parse(
			[
				'docs: explain warning',
				'',
				'Warning: this paragraph starts like a trailer.',
				'This line makes the final block ordinary prose.'
			].join('\n')
		);

		expect(documentFields(document)).toStrictEqual({
			body: [
				'Warning: this paragraph starts like a trailer.',
				'This line makes the final block ordinary prose.',
				''
			].join('\n'),
			separatorMissing: false,
			subject: 'docs: explain warning',
			trailers: []
		});
	});

	it('keeps folded git trailers out of the prose body', () => {
		const document = CommitMessageDocument.parse(
			[
				'feat: add collaboration',
				'',
				'Explain the change.',
				'',
				'Co-authored-by: Alice Example',
				' <alice@example.com>',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
			].join('\n')
		);

		expect(documentFields(document)).toStrictEqual({
			body: 'Explain the change.\n',
			separatorMissing: false,
			subject: 'feat: add collaboration',
			trailers: [
				'Co-authored-by: Alice Example',
				' <alice@example.com>',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
			]
		});
	});

	it('rebuilds messages without reflowing trailers into prose', () => {
		const document = CommitMessageDocument.parse(
			[
				'feat: add collaboration',
				'',
				'Explain the change.',
				'',
				'Co-authored-by: Alice Example <alice@example.com>',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
			].join('\n')
		);

		expect(document.withBody('Explain the change in more detail.\n')).toBe(
			[
				'feat: add collaboration',
				'',
				'Explain the change in more detail.',
				'',
				'Co-authored-by: Alice Example <alice@example.com>',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
			].join('\n')
		);
	});
});

describe('MarkdownBodyReflower', () => {
	const reflower = new MarkdownBodyReflower();

	it('wraps plain prose to 72 columns', () => {
		expect(
			reflowSummary(
				reflower.reflow(
					[
						'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.',
						''
					].join('\n')
				)
			)
		).toStrictEqual({
			changed: true,
			original: [
				'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.',
				''
			].join('\n'),
			reflowed: [
				'An unwrapped paragraph with enough words to exceed the configured',
				'seventy two column width so the reflower must wrap it.',
				''
			].join('\n')
		});
	});

	it('does not rewrite Markdown tables or code fences', () => {
		const body = [
			'| Column | Description |',
			'| --- | --- |',
			'| path | This deliberately stays as a table row even when it is far longer than the prose width. |',
			'',
			'```text',
			'This deliberately stays as code even when it is far longer than the prose width.',
			'```',
			''
		].join('\n');

		expect(reflowSummary(reflower.reflow(body))).toStrictEqual({
			changed: false,
			original: body,
			reflowed: body
		});
	});

	it('preserves inline Markdown syntax while wrapping around it', () => {
		const body = [
			'See [the release notes](https://example.com/releases/2026/06/09) before changing `*.ts` files because those details explain the compatibility rules.',
			''
		].join('\n');

		expect(reflowSummary(reflower.reflow(body))).toStrictEqual({
			changed: true,
			original: body,
			reflowed: [
				'See [the release notes](https://example.com/releases/2026/06/09) before',
				'changing `*.ts` files because those details explain the compatibility',
				'rules.',
				''
			].join('\n')
		});
	});

	it('keeps bare URLs intact', () => {
		const body = [
			'Read https://example.com/releases/2026/06/09/with/a/very/long/path before changing the compatibility rules for clients.',
			''
		].join('\n');

		expect(reflowSummary(reflower.reflow(body))).toStrictEqual({
			changed: true,
			original: body,
			reflowed: [
				'Read https://example.com/releases/2026/06/09/with/a/very/long/path',
				'before changing the compatibility rules for clients.',
				''
			].join('\n')
		});
	});

	it('wraps list items using hanging indentation', () => {
		const body = [
			'- This list item has enough prose to exceed the configured seventy two column width and should keep a hanging indent.',
			''
		].join('\n');

		expect(reflowSummary(reflower.reflow(body))).toStrictEqual({
			changed: true,
			original: body,
			reflowed: [
				'- This list item has enough prose to exceed the configured seventy two',
				'  column width and should keep a hanging indent.',
				''
			].join('\n')
		});
	});

	it('uses display width for wide characters', () => {
		const body = [
			'これはとても長い日本語の文章ですこれはとても長い日本語の文章ですこれはとても長い日本語の文章ですこれはとても長い日本語の文章です',
			''
		].join('\n');

		expect(reflowSummary(reflower.reflow(body))).toStrictEqual({
			changed: true,
			original: body,
			reflowed: [
				'これはとても長い日本語の文章ですこれはとても長い日本語の文章ですこれはと',
				'ても長い日本語の文章ですこれはとても長い日本語の文章です',
				''
			].join('\n')
		});
	});

	it('leaves hard-break paragraphs unchanged', () => {
		const body = [
			'First line with a Markdown hard break  ',
			'second line',
			''
		].join('\n');

		expect(reflowSummary(reflower.reflow(body))).toStrictEqual({
			changed: false,
			original: body,
			reflowed: body
		});
	});

	it.each([
		'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.\n',
		'See [the release notes](https://example.com/releases/2026/06/09) before changing `*.ts` files because those details explain the compatibility rules.\n',
		'- This list item has enough prose to exceed the configured seventy two column width and should keep a hanging indent.\n',
		'Read https://example.com/releases/2026/06/09/with/a/very/long/path before changing the compatibility rules for clients.\n',
		'これはとても長い日本語の文章ですこれはとても長い日本語の文章ですこれはとても長い日本語の文章ですこれはとても長い日本語の文章です\n'
	])('is idempotent: reflowing the result changes nothing (%#)', (body) => {
		const once = reflower.reflow(body).reflowed;

		expect(reflower.reflow(once).reflowed).toBe(once);
	});
});

function documentFields(document: CommitMessageDocument): {
	readonly body: string;
	readonly separatorMissing: boolean;
	readonly subject: string;
	readonly trailers: readonly string[];
} {
	return {
		body: document.body,
		separatorMissing: document.separatorMissing,
		subject: document.subject,
		trailers: document.trailers
	};
}

function reflowSummary(reflow: MarkdownBodyReflow): {
	readonly changed: boolean;
	readonly original: string;
	readonly reflowed: string;
} {
	return {
		changed: reflow.changed,
		original: reflow.original,
		reflowed: reflow.reflowed
	};
}
