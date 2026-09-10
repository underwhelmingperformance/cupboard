import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every statement in `packages/server` binds a list as one JSON parameter, so
// that no statement's parameter count follows the data it reads.
// `statement-parameters.test.ts` compares the count at one value and at ten
// thousand, which covers the statements it has a case for. This test covers the
// rest: a statement with no case there is invisible to it. Such a site has no
// distinguishing name to search for, so the scan finds it by the type of the
// argument.
//
// A finding is a call whose parameter count grows with its input: `inArray` or
// `notInArray` over an array rather than a bound list, a multi-row `.values()`,
// or a spread `or`/`and`. A site whose width cannot follow runtime data is
// listed in `fixedWidthSites` with the reason, so adding one is a decision a
// reviewer sees.
//
// This test reads the server package with the TypeScript API, which needs Node,
// so it lives here rather than in that package, whose own lint rules restrict
// it to Worker APIs.
const packageRoot = path.join(import.meta.dirname, '..', 'packages', 'server');

interface BoundListSite {
	/**
	The call that could bind one parameter for each value.
	*/
	readonly kind: 'inArray' | 'notInArray' | 'values' | 'or' | 'and';
	/**
	The package-relative file, with no line, so an entry survives an edit above it.
	*/
	readonly file: string;
	/**
	The argument as written, which identifies the site within its file.
	*/
	readonly argument: string;
}

/**
 * The sites whose width cannot follow runtime data, each with the reason. A new
 * entry means a reader has checked that the list has a fixed length, or that
 * its elements are themselves bound lists.
 */
const fixedWidthSites: readonly (BoundListSite & {
	readonly reason: string;
})[] = [
	{
		kind: 'inArray',
		file: 'src/blob/object-incarnation-recovery.ts',
		argument: "['pending', 'live']",
		reason: 'The two incarnation states, written as literals.'
	},
	{
		kind: 'inArray',
		file: 'src/do/upload-state-service.ts',
		argument: "['pending', 'committing']",
		reason: 'The two live commit verdicts, written as literals.'
	},
	{
		kind: 'inArray',
		file: 'src/do/commit-pipeline-service.ts',
		argument: "['committing', 'pending']",
		reason: 'The two live commit verdicts, written as literals.'
	},
	{
		kind: 'notInArray',
		file: 'src/control/tenant-registry.ts',
		argument: "['offboarding', 'offboarded']",
		reason: 'The two terminal tenant statuses, written as literals.'
	},
	{
		kind: 'inArray',
		file: 'src/control/global-admin.ts',
		argument: 'issuers',
		reason:
			'The principal issuer, and the legacy issuer when there is one: two at most.'
	},
	{
		kind: 'values',
		file: 'src/do/cache-lifecycle-projection.ts',
		argument: 'batch.map((cache) => { const { scope, access } = i',
		reason:
			'The caller chunks the caches it projects by `projectedRowsPerStatement`.'
	},
	{
		kind: 'or',
		file: 'src/db/cache.ts',
		argument: 'or( ...jsonRowLists( selectors.map((selector) => l',
		reason:
			'One disjunct per bound list, not per selector. A view with more selectors produces longer lists, not more disjuncts.'
	},
	// The four entries below hold only while both spellings of a reuse view are
	// stored. Each list is the legacy and the native name of one view, so it has
	// two entries at most. The contraction drops the legacy spelling and these
	// entries go with it.
	{
		kind: 'inArray',
		file: 'src/do/reuse-view-admin-service.ts',
		argument: 'keys',
		reason: 'The legacy and native spellings of one view: two at most.'
	},
	{
		kind: 'inArray',
		file: 'src/do/reuse-view-lookup-service.ts',
		argument: 'keys',
		reason: 'The legacy and native spellings of one view: two at most.'
	},
	{
		kind: 'inArray',
		file: 'src/do/reuse-view-lookup-service.ts',
		argument: 'legacyReuseViewKeys(view)',
		reason: 'The legacy and native spellings of one view: two at most.'
	},
	{
		kind: 'inArray',
		file: 'src/routing/scheduled.ts',
		argument: "['active', 'suspended']",
		reason: 'The two tenant statuses a sweep visits, written as literals.'
	},
	{
		kind: 'and',
		file: 'src/migration/cache-retention.ts',
		argument: "and( eq(schema.legacyRetentionPolicies.kind, 'root",
		reason:
			'The spread holds the keyset cursor: one condition once the migration has a cursor, none before that.'
	},
	{
		kind: 'and',
		file: 'src/migration/cache-retention.ts',
		argument: 'and(...cursorConditions, isNull(schema.cacheIdenti',
		reason:
			'The spread holds the keyset cursor: one condition once the migration has a cursor, none before that.'
	},
	{
		kind: 'values',
		file: 'src/test-support.ts',
		argument: 'batch.map((narHash) => ({ narHash, fileHash: narHa',
		reason: 'Fixture seeding. The helper chunks the batch it inserts.'
	},
	{
		kind: 'values',
		file: 'src/test-support.ts',
		argument: "batch.map((narHash) => ({ kind: 'nar' as const, ob",
		reason: 'Fixture seeding. The helper chunks the batch it inserts.'
	},
	{
		kind: 'values',
		file: 'src/test-support.ts',
		argument: 'batch.map((digest) => ({ digest, size: 1, storedAt',
		reason: 'Fixture seeding. The helper chunks the batch it inserts.'
	},
	{
		kind: 'values',
		file: 'src/test-support.ts',
		argument: "batch.map((digest) => ({ kind: 'cas' as const, obj",
		reason: 'Fixture seeding. The helper chunks the batch it inserts.'
	}
];

function isArrayLike(type: ts.Type, checker: ts.TypeChecker): boolean {
	if (checker.isArrayType(type) || checker.isTupleType(type)) {
		return true;
	}

	return type.isUnion()
		? type.types.some((member) => isArrayLike(member, checker))
		: false;
}

/**
The argument text on one line, cut to the length an entry records.
*/
function argumentText(node: ts.Node): string {
	return node.getText().replaceAll(/\s+/gu, ' ').slice(0, 50);
}

function scanPackage(): readonly BoundListSite[] {
	const configPath = path.join(packageRoot, 'tsconfig.json');
	const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
	const parsed = ts.parseJsonConfigFileContent(
		read.config as unknown,
		ts.sys,
		packageRoot
	);
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const checker = program.getTypeChecker();
	const sites: BoundListSite[] = [];

	for (const file of program.getSourceFiles()) {
		if (file.isDeclarationFile || !file.fileName.startsWith(packageRoot)) {
			continue;
		}

		// A test file binds its own fixtures and is not a production statement.
		if (file.fileName.endsWith('.test.ts')) {
			continue;
		}

		const relative = path.relative(packageRoot, file.fileName);

		const record = (
			kind: BoundListSite['kind'],
			argument: ts.Node | undefined
		): void => {
			if (argument === undefined) {
				return;
			}

			if (!isArrayLike(checker.getTypeAtLocation(argument), checker)) {
				return;
			}

			sites.push({ kind, file: relative, argument: argumentText(argument) });
		};

		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const callee = node.expression.getText();

				if (callee === 'inArray' || callee === 'notInArray') {
					record(callee, node.arguments[1]);
				}

				if (callee.endsWith('.values')) {
					record('values', node.arguments[0]);
				}

				if (
					(callee === 'or' || callee === 'and') &&
					node.arguments.some((argument) => ts.isSpreadElement(argument))
				) {
					sites.push({
						kind: callee,
						file: relative,
						argument: argumentText(node)
					});
				}
			}

			ts.forEachChild(node, visit);
		};

		visit(file);
	}

	return sites;
}

function isSameSite(left: BoundListSite, right: BoundListSite): boolean {
	return (
		left.kind === right.kind &&
		left.file === right.file &&
		left.argument === right.argument
	);
}

const sites = scanPackage();

describe('statements that could bind one parameter for each value', () => {
	it('are all either bound lists or listed as fixed width', () => {
		const unaccounted = sites.filter((site) =>
			fixedWidthSites.every((allowed) => !isSameSite(allowed, site))
		);

		expect(unaccounted).toStrictEqual([]);
	});

	// An entry that matches nothing would hide the next site that resembles it.
	it('still exist for every entry the allowlist names', () => {
		const stale = fixedWidthSites.filter((allowed) =>
			sites.every((site) => !isSameSite(allowed, site))
		);

		expect(
			stale.map((entry) => `${entry.file}: ${entry.argument}`)
		).toStrictEqual([]);
	});
});
