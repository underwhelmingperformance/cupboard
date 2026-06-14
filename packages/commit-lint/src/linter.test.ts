import { describe, expect, it } from 'vitest';

import {
	checkCommitMessages,
	commitBody,
	type CommitMessage,
	CommitMessageCheck,
	type Finding,
	formatBodyPatch,
	UnchangedCommitMessageCheckError
} from './linter.ts';
import {
	type CommitMessageJsonFinding,
	jsonReport,
	terminalFailureReport
} from './report.ts';

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	let rejected: unknown;

	try {
		await run();
	} catch (error) {
		rejected = error;
	}

	return rejected;
}

function expectUnchangedCommitMessageCheckError(
	error: unknown
): asserts error is UnchangedCommitMessageCheckError {
	expect(error).toBeInstanceOf(UnchangedCommitMessageCheckError);
}

function expectCommitMessageCheck(
	check: CommitMessageCheck | undefined
): asserts check is CommitMessageCheck {
	expect(check).toBeInstanceOf(CommitMessageCheck);
}

type StructuralFinding =
	| Omit<Extract<Finding, { readonly kind: 'body-format' }>, 'message'>
	| Omit<Extract<Finding, { readonly kind: 'rule' }>, 'message'>;

function findingShape(finding: Finding): StructuralFinding {
	switch (finding.kind) {
		case 'body-format': {
			return {
				kind: finding.kind,
				actual: finding.actual,
				expected: finding.expected,
				fixable: finding.fixable,
				patch: finding.patch,
				rule: finding.rule
			};
		}
		case 'rule': {
			return {
				kind: finding.kind,
				fixable: finding.fixable,
				rule: finding.rule
			};
		}
	}

	const exhaustive: never = finding;

	return exhaustive;
}

function findingShapes(findings: readonly Finding[]): StructuralFinding[] {
	return findings.map((finding) => findingShape(finding));
}

type StructuralJsonFinding = Omit<CommitMessageJsonFinding, 'message'>;

function jsonFindingShape(
	finding: CommitMessageJsonFinding
): StructuralJsonFinding {
	return {
		fixable: finding.fixable,
		...(finding.actual === undefined ? {} : { actual: finding.actual }),
		...(finding.expected === undefined ? {} : { expected: finding.expected }),
		...(finding.rule === undefined ? {} : { rule: finding.rule })
	};
}

function jsonFindingShapes(
	findings: readonly CommitMessageJsonFinding[]
): StructuralJsonFinding[] {
	return findings.map((finding) => jsonFindingShape(finding));
}

describe('checkCommitMessages', () => {
	it('accepts a conventional commit with no body', async () => {
		const reports = await checkCommitMessages([
			commitMessage('a1b2c3d4e5f6', 'feat: add upload')
		]);

		expect(
			reports.map((report) => ({
				changed: report.changed,
				findings: report.findings,
				label: report.commitMessage.label,
				passed: report.passed,
				status: report.status
			}))
		).toStrictEqual([
			{
				changed: false,
				findings: [],
				label: 'a1b2c3d4e5f6',
				passed: true,
				status: 'passed'
			}
		]);
	});

	it('throws a concrete error when a passed check is reworded', async () => {
		const [check] = await checkCommitMessages([
			commitMessage('a1b2c3d4e5f6', 'feat: add upload')
		]);
		const error = await rejectedBy(() =>
			Promise.resolve(check?.rewordMessage())
		);

		expectUnchangedCommitMessageCheckError(error);
		expect({
			name: error.name,
			changed: error.check.changed,
			status: error.check.status,
			commitMessage: error.check.commitMessage
		}).toStrictEqual({
			name: 'UnchangedCommitMessageCheckError',
			changed: false,
			status: 'passed',
			commitMessage: {
				label: 'a1b2c3d4e5f6',
				message: 'feat: add upload',
				subject: 'feat: add upload'
			}
		});
	});

	it('inserts a blank line before a git trailer glued to the body', async () => {
		const [check] = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'fix: tidy parser',
					'',
					'This line is ordinary prose.',
					'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
				].join('\n')
			)
		]);

		expect({
			changed: check?.changed,
			fixedMessage: check?.fixedMessage,
			status: check?.status
		}).toStrictEqual({
			changed: true,
			fixedMessage: [
				'fix: tidy parser',
				'',
				'This line is ordinary prose.',
				'',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
			].join('\n'),
			status: 'fixable'
		});
	});

	it('separates a glued trailer run that contains a recognised trailer', async () => {
		const [check] = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'feat: pair on the parser',
					'',
					'Tidy the trailer handling.',
					'Co-authored-by: Alice Example <alice@example.test>',
					'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
				].join('\n')
			)
		]);

		expect({
			changed: check?.changed,
			fixedMessage: check?.fixedMessage,
			status: check?.status
		}).toStrictEqual({
			changed: true,
			fixedMessage: [
				'feat: pair on the parser',
				'',
				'Tidy the trailer handling.',
				'',
				'Co-authored-by: Alice Example <alice@example.test>',
				'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
			].join('\n'),
			status: 'fixable'
		});
	});

	it('leaves a correctly separated trailer block unchanged', async () => {
		const message = [
			'fix: tidy parser',
			'',
			'This line is ordinary prose.',
			'',
			'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
		].join('\n');

		const [check] = await checkCommitMessages([
			commitMessage('a1b2c3d4e5f6', message)
		]);

		expect({
			changed: check?.changed,
			fixedMessage: check?.fixedMessage,
			status: check?.status
		}).toStrictEqual({
			changed: false,
			fixedMessage: message,
			status: 'passed'
		});
	});

	it('enforces a 72-column body line limit', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'fix: tighten validation',
					'',
					'This line is deliberately longer than seventy two columns but still under one hundred.'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				changed: report.changed,
				findings: findingShapes(report.findings),
				label: report.commitMessage.label,
				status: report.status
			}))
		).toStrictEqual([
			{
				changed: true,
				findings: [
					{
						kind: 'body-format',
						actual:
							'This line is deliberately longer than seventy two columns but still under one hundred.\n',
						expected:
							'This line is deliberately longer than seventy two columns but still\nunder one hundred.\n',
						fixable: true,
						patch: formatBodyPatch(
							'This line is deliberately longer than seventy two columns but still under one hundred.\n',
							'This line is deliberately longer than seventy two columns but still\nunder one hundred.\n'
						),
						rule: 'body-format'
					}
				],
				label: 'a1b2c3d4e5f6',
				status: 'fixable'
			}
		]);
	});

	it('shows the diff after Markdown-aware wrapping', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'docs: explain commit linting',
					'',
					'Short paragraph with trailing spaces.   ',
					'',
					'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				changed: report.changed,
				findings: findingShapes(report.findings),
				label: report.commitMessage.label,
				status: report.status
			}))
		).toStrictEqual([
			{
				changed: true,
				findings: [
					{
						kind: 'body-format',
						actual: [
							'Short paragraph with trailing spaces.   ',
							'',
							'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.',
							''
						].join('\n'),
						expected: [
							'Short paragraph with trailing spaces.',
							'',
							'An unwrapped paragraph with enough words to exceed the configured',
							'seventy two column width so the reflower must wrap it.',
							''
						].join('\n'),
						fixable: true,
						patch: formatBodyPatch(
							[
								'Short paragraph with trailing spaces.   ',
								'',
								'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.',
								''
							].join('\n'),
							[
								'Short paragraph with trailing spaces.',
								'',
								'An unwrapped paragraph with enough words to exceed the configured',
								'seventy two column width so the reflower must wrap it.',
								''
							].join('\n')
						),
						rule: 'body-format'
					}
				],
				label: 'a1b2c3d4e5f6',
				status: 'fixable'
			}
		]);
	});

	it('produces a reworded message that passes the same linter', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'docs: explain commit linting',
					'',
					'Short paragraph with trailing spaces. ',
					'',
					'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				changed: report.changed,
				findings: findingShapes(report.findings),
				label: report.commitMessage.label,
				status: report.status
			}))
		).toStrictEqual([
			{
				changed: true,
				findings: [
					{
						kind: 'body-format',
						actual: [
							'Short paragraph with trailing spaces. ',
							'',
							'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.',
							''
						].join('\n'),
						expected: [
							'Short paragraph with trailing spaces.',
							'',
							'An unwrapped paragraph with enough words to exceed the configured',
							'seventy two column width so the reflower must wrap it.',
							''
						].join('\n'),
						fixable: true,
						patch: formatBodyPatch(
							[
								'Short paragraph with trailing spaces. ',
								'',
								'An unwrapped paragraph with enough words to exceed the configured seventy two column width so the reflower must wrap it.',
								''
							].join('\n'),
							[
								'Short paragraph with trailing spaces.',
								'',
								'An unwrapped paragraph with enough words to exceed the configured',
								'seventy two column width so the reflower must wrap it.',
								''
							].join('\n')
						),
						rule: 'body-format'
					}
				],
				label: 'a1b2c3d4e5f6',
				status: 'fixable'
			}
		]);

		const [check] = reports;
		expectCommitMessageCheck(check);
		const fixedMessage = check.rewordMessage();
		const fixedReports = await checkCommitMessages([
			commitMessage('a1b2c3d4e5f6', fixedMessage)
		]);

		expect({
			fixedMessage: [
				'docs: explain commit linting',
				'',
				'Short paragraph with trailing spaces.',
				'',
				'An unwrapped paragraph with enough words to exceed the configured',
				'seventy two column width so the reflower must wrap it.'
			].join('\n'),
			reports: fixedReports.map((report) => ({
				changed: report.changed,
				findings: findingShapes(report.findings),
				label: report.commitMessage.label,
				status: report.status
			}))
		}).toStrictEqual({
			fixedMessage: [
				'docs: explain commit linting',
				'',
				'Short paragraph with trailing spaces.',
				'',
				'An unwrapped paragraph with enough words to exceed the configured',
				'seventy two column width so the reflower must wrap it.'
			].join('\n'),
			reports: [
				{
					changed: false,
					findings: [],
					label: 'a1b2c3d4e5f6',
					status: 'passed'
				}
			]
		});
	});

	it('does not reflow git trailers into the body', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'fix: keep trailers intact',
					'',
					'This body needs wrapping because it is longer than the configured seventy two column width for commit message prose.',
					'',
					'Co-authored-by: Alice Example <alice@example.com>',
					'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				failures: findingShapes(report.findings),
				fixedMessage: report.fixedMessage,
				status: report.status
			}))
		).toStrictEqual([
			{
				failures: [
					{
						kind: 'body-format',
						actual:
							'This body needs wrapping because it is longer than the configured seventy two column width for commit message prose.\n',
						expected:
							'This body needs wrapping because it is longer than the configured\n' +
							'seventy two column width for commit message prose.\n',
						fixable: true,
						patch: formatBodyPatch(
							'This body needs wrapping because it is longer than the configured seventy two column width for commit message prose.\n',
							'This body needs wrapping because it is longer than the configured\n' +
								'seventy two column width for commit message prose.\n'
						),
						rule: 'body-format'
					}
				],
				fixedMessage: [
					'fix: keep trailers intact',
					'',
					'This body needs wrapping because it is longer than the configured',
					'seventy two column width for commit message prose.',
					'',
					'Co-authored-by: Alice Example <alice@example.com>',
					'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
				].join('\n'),
				status: 'fixable'
			}
		]);
	});

	it('exempts unknown trailer-like final blocks from body checks', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'docs: explain external issue',
					'',
					'Issue: PROJECT-123 with a deliberately long value that should remain trailer text rather than being wrapped.',
					'Reviewed-on: https://example.com/reviews/1234567890'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				failures: findingShapes(report.findings),
				fixedMessage: report.fixedMessage,
				status: report.status
			}))
		).toStrictEqual([
			{
				failures: [],
				fixedMessage: [
					'docs: explain external issue',
					'',
					'Issue: PROJECT-123 with a deliberately long value that should remain trailer text rather than being wrapped.',
					'Reviewed-on: https://example.com/reviews/1234567890'
				].join('\n'),
				status: 'passed'
			}
		]);
	});

	it('preserves folded git trailers', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'fix: keep folded trailers intact',
					'',
					'This body needs wrapping because it is longer than the configured seventy two column width for commit message prose.',
					'',
					'Co-authored-by: Alice Example',
					' <alice@example.com>',
					'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				fixedMessage: report.fixedMessage,
				status: report.status
			}))
		).toStrictEqual([
			{
				fixedMessage: [
					'fix: keep folded trailers intact',
					'',
					'This body needs wrapping because it is longer than the configured',
					'seventy two column width for commit message prose.',
					'',
					'Co-authored-by: Alice Example',
					' <alice@example.com>',
					'Signed-off-by: Iain Lane <iain@orangesquash.org.uk>'
				].join('\n'),
				status: 'fixable'
			}
		]);
	});

	it('does not mark a changed body as fixable when markdownlint still fails', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'docs: explain duplicate headings',
					'',
					'## Details',
					'',
					'This body paragraph is deliberately longer than seventy two columns so the reflower changes it.',
					'',
					'## Details'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				failures: report.findings.map((failure) => ({
					fixable: failure.fixable,
					kind: failure.kind,
					rule: failure.rule
				})),
				status: report.status
			}))
		).toStrictEqual([
			{
				failures: [
					{
						fixable: false,
						kind: 'body-format',
						rule: 'body-format'
					},
					{
						fixable: false,
						kind: 'rule',
						rule: 'MD024'
					}
				],
				status: 'failed'
			}
		]);
	});

	it('does not apply markdownlint defaults to commit bodies', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'docs: keep common markdown',
					'',
					'See https://example.com/change for details.',
					'',
					'```',
					'plain text',
					'```'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				failures: findingShapes(report.findings),
				status: report.status
			}))
		).toStrictEqual([
			{
				failures: [],
				status: 'passed'
			}
		]);
	});

	it('preserves prose punctuation while wrapping the body', async () => {
		const reports = await checkCommitMessages([
			commitMessage(
				'a1b2c3d4e5f6',
				[
					'fix: preserve prose characters',
					'',
					'Keep the updated *.ts glob, _private marker, and [draft] label intact while wrapping this prose paragraph.'
				].join('\n')
			)
		]);

		expect(
			reports.map((report) => ({
				failures: findingShapes(report.findings),
				fixedMessage: report.fixedMessage,
				status: report.status
			}))
		).toStrictEqual([
			{
				failures: [
					{
						kind: 'body-format',
						actual:
							'Keep the updated *.ts glob, _private marker, and [draft] label intact while wrapping this prose paragraph.\n',
						expected:
							'Keep the updated *.ts glob, _private marker, and [draft] label intact\n' +
							'while wrapping this prose paragraph.\n',
						fixable: true,
						patch: formatBodyPatch(
							'Keep the updated *.ts glob, _private marker, and [draft] label intact while wrapping this prose paragraph.\n',
							'Keep the updated *.ts glob, _private marker, and [draft] label intact\n' +
								'while wrapping this prose paragraph.\n'
						),
						rule: 'body-format'
					}
				],
				fixedMessage: [
					'fix: preserve prose characters',
					'',
					'Keep the updated *.ts glob, _private marker, and [draft] label intact',
					'while wrapping this prose paragraph.'
				].join('\n'),
				status: 'fixable'
			}
		]);
	});

	it('returns a separate report for each commit message', async () => {
		const reports = await checkCommitMessages([
			commitMessage('111111111111', 'feat: add cache check'),
			commitMessage('222222222222', 'not conventional')
		]);

		expect(
			reports.map((report) => ({
				failures: report.findings.map((failure) => ({
					kind: failure.kind,
					rule: failure.rule
				})),
				label: report.commitMessage.label,
				subject: report.commitMessage.subject
			}))
		).toStrictEqual([
			{
				failures: [],
				label: '111111111111',
				subject: 'feat: add cache check'
			},
			{
				failures: [
					{
						kind: 'rule',
						rule: 'subject-empty'
					},
					{
						kind: 'rule',
						rule: 'type-empty'
					}
				],
				label: '222222222222',
				subject: 'not conventional'
			}
		]);
	});
});

describe('commitBody', () => {
	it('strips the subject and surrounding blank lines', () => {
		expect(
			commitBody(
				['feat: add cache check', '', '', 'This is the body.', '', ''].join(
					'\n'
				)
			)
		).toBe('This is the body.\n');
	});
});

describe('jsonReport', () => {
	it('emits only failing commits in the machine-readable report', () => {
		const report = jsonReport('failed', [
			new CommitMessageCheck(
				commitMessage('111111111111', 'feat: add cache check'),
				'feat: add cache check',
				'feat: add cache check',
				[]
			),
			new CommitMessageCheck(
				commitMessage('222222222222', 'not conventional'),
				'not conventional',
				'not conventional',
				[
					{
						kind: 'rule',
						fixable: false,
						message: 'type-empty: type may not be empty',
						rule: 'type-empty'
					}
				]
			)
		]);

		expect({
			...report,
			failures: report.failures.map((failure) => ({
				...failure,
				findings: jsonFindingShapes(failure.findings)
			}))
		}).toStrictEqual({
			event: 'commit-message-lint',
			failures: [
				{
					commit: '222222222222',
					findings: [
						{
							fixable: false,
							rule: 'type-empty'
						}
					],
					subject: 'not conventional'
				}
			],
			status: 'failed',
			total: 2
		});
	});
});

describe('terminalFailureReport', () => {
	it('includes the failing commit and body diff', () => {
		const lines = terminalFailureReport(
			[
				new CommitMessageCheck(
					commitMessage('222222222222', 'docs: explain commit linting'),
					'docs: explain commit linting',
					'docs: explain commit linting',
					[
						{
							kind: 'body-format',
							actual: 'too long\n',
							expected: 'wrapped\n',
							fixable: true,
							message: 'body is not wrapped to 72 columns',
							patch: formatBodyPatch('too long\n', 'wrapped\n'),
							rule: 'body-format'
						}
					]
				)
			],
			2
		)
			.replaceAll(
				new RegExp(String.raw`${String.fromCodePoint(27)}\[[\d;]*m`, 'g'),
				''
			)
			.split('\n');

		expect(lines).toStrictEqual([
			'Commit message lint failed for 1 commit message out of 2.',
			'',
			'222222222222 docs: explain commit linting',
			'  x body is not wrapped to 72 columns',
			'    Index: commit-body.md',
			'    ===================================================================',
			'    --- commit-body.md\tactual',
			'    +++ commit-body.md\tcheck',
			'    @@ -1,1 +1,1 @@',
			'    -too long',
			'    +wrapped'
		]);
	});
});

function commitMessage(label: string, message: string): CommitMessage {
	return {
		label,
		message,
		subject: message.split('\n', 1)[0] ?? ''
	};
}
