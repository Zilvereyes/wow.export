/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const path = require('path');

const CASC_KEY_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * Ensure a CASC identifier is a complete hexadecimal key.
 * @param {string} key
 * @param {string} label
 * @returns {string}
 */
const assertCASCKey = (key, label = 'CASC key') => {
	if (typeof key !== 'string' || !CASC_KEY_PATTERN.test(key))
		throw new Error(`Invalid ${label}: expected a 32-character hexadecimal value.`);

	return key;
};

/**
 * Resolve a cache file while ensuring it remains beneath the selected root.
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
const resolveCachePath = (root, file) => {
	if (typeof root !== 'string' || root.length === 0)
		throw new Error('Invalid cache root.');

	if (typeof file !== 'string' || file.length === 0)
		throw new Error('Invalid cache file name.');

	const resolvedRoot = path.resolve(root);
	const resolvedFile = path.resolve(resolvedRoot, file);
	const relative = path.relative(resolvedRoot, resolvedFile);
	const escapesRoot = relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);

	if (escapesRoot)
		throw new Error(`Cache file resolves outside the selected cache directory: ${file}`);

	return resolvedFile;
};

module.exports = { assertCASCKey, resolveCachePath };
