const { describe, expect, test } = require('bun:test');
const path = require('path');
const { assertCASCKey, resolveCachePath } = require('../../src/js/casc/cache-path');

describe('CASC key validation', () => {
	test('accepts canonical hexadecimal keys', () => {
		expect(assertCASCKey('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
		expect(assertCASCKey('ABCDEF0123456789ABCDEF0123456789')).toBe('ABCDEF0123456789ABCDEF0123456789');
	});

	test('rejects malformed and traversal keys', () => {
		for (const key of [
			'../0123456789abcdef0123456789abcdef',
			'..\\0123456789abcdef0123456789abcdef',
			'C:\\0123456789abcdef0123456789abcdef',
			'\\\\server\\share\\0123456789abcdef0123456789abcdef',
			'0123456789abcdef0123456789abcde',
			'0123456789abcdef0123456789abcdeg'
		]) {
			expect(() => assertCASCKey(key)).toThrow('expected a 32-character hexadecimal value');
		}
	});
});

describe('cache path containment', () => {
	const root = path.resolve('cache-root');

	test('keeps ordinary cache files beneath root', () => {
		expect(resolveCachePath(root, '0123456789abcdef.index')).toBe(path.join(root, '0123456789abcdef.index'));
		expect(resolveCachePath(root, path.join('nested', 'file'))).toBe(path.join(root, 'nested', 'file'));
	});

	test('rejects paths outside cache root', () => {
		for (const file of [
			'..',
			path.join('..', 'outside.index'),
			path.resolve(root, '..', 'outside.index'),
			'.'
		]) {
			expect(() => resolveCachePath(root, file)).toThrow('outside the selected cache directory');
		}
	});
});
