/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */

const argv = process.argv.splice(2);
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
const fsp = fs.promises;

const log_output = [];

/**
 * Defines the maximum amount of retries to update a file.
 * @type {number}
 */
const MAX_LOCK_TRIES = 30;

function get_timestamp() {
	const time = new Date();
	
	return util.format(
		'%s:%s:%s',
		time.getHours().toString().padStart(2, '0'),
		time.getMinutes().toString().padStart(2, '0'),
		time.getSeconds().toString().padStart(2, '0'));
}

function log (message, ...params) {
	const out = '[' + get_timestamp() + '] ' + util.format(message, ...params);
	log_output.push(out);
	console.log(out);
}

function resolve_update_path(root, file) {
	if (typeof file !== 'string' || file.length === 0)
		throw new Error('Update contains an invalid file path.');

	const segments = file.split('/');
	const is_canonical = !file.includes('\\')
		&& !file.includes('\0')
		&& !path.posix.isAbsolute(file)
		&& !path.win32.isAbsolute(file)
		&& path.posix.normalize(file) === file
		&& segments.every(segment => segment.length > 0
			&& segment !== '.'
			&& segment !== '..'
			&& !segment.includes(':')
			&& !/[. ]$/.test(segment));
	if (!is_canonical)
		throw new Error('Update contains an unsafe file path: ' + file);

	const resolved_root = path.resolve(root);
	const resolved_path = path.resolve(resolved_root, ...segments);
	const relative_path = path.relative(resolved_root, resolved_path);
	const is_contained = relative_path.length > 0
		&& relative_path !== '..'
		&& !relative_path.startsWith('..' + path.sep)
		&& !path.isAbsolute(relative_path);
	if (!is_contained)
		throw new Error('Update file path escapes the update root: ' + file);

	return resolved_path;
}

async function assert_update_path_contained(root, target) {
	const resolved_root = path.resolve(root);
	const relative_path = path.relative(resolved_root, target);
	if (relative_path.length === 0
		|| relative_path === '..'
		|| relative_path.startsWith('..' + path.sep)
		|| path.isAbsolute(relative_path))
		throw new Error('Update path escapes its root.');

	const root_stats = await fsp.lstat(resolved_root);
	if (root_stats.isSymbolicLink())
		throw new Error('Update root cannot be a symbolic link.');

	const real_root = await fsp.realpath(resolved_root);
	let current_path = resolved_root;
	for (const segment of relative_path.split(path.sep)) {
		current_path = path.join(current_path, segment);

		try {
			await fsp.lstat(current_path);
		} catch (e) {
			if (e.code === 'ENOENT')
				return;

			throw e;
		}

		const real_path = await fsp.realpath(current_path);
		const real_relative_path = path.relative(real_root, real_path);
		if (real_relative_path === '..'
			|| real_relative_path.startsWith('..' + path.sep)
			|| path.isAbsolute(real_relative_path))
			throw new Error('Update path resolves outside its root.');
	}
}

async function collect_files(dir, out = []) {
	const entries = await fsp.readdir(dir, { withFileTypes: true });
	for await (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory())
			await collect_files(entryPath, out);
		else
			out.push(entryPath);
	}

	return out;
}

function delete_directory(dir) {
	if (fs.existsSync(dir)) {
		let entries = fs.readdirSync(dir);

		for (let entry of entries) {
			let entryPath = path.join(dir, entry);
			let entryStat = fs.lstatSync(entryPath);

			// Recursively delete as a directory or unlink the file/symlink.
			if (entryStat.isFile() || entryStat.isSymbolicLink())
				fs.unlinkSync(entryPath);
			else
				delete_directory(entryPath);
		}

		fs.rmdirSync(dir);
	}
}

async function file_exists(file) {
	try {
		await fsp.access(file, fs.constants.F_OK);
		return true;
	} catch (e) {
		return false;
	}
}

async function is_file_locked(file) {
	try {
		await fsp.access(file, fs.constants.W_OK);
		return false;
	} catch (e) {
		return true;
	}
}

(async () => {
	try {
		log('Updater has started.');
	
		// Ensure we were given a valid PID by whatever spawned us.
		const pid = Number(argv[0]);
		if (!isNaN(pid)) {
			// Wait for the parent process (PID) to terminate.
			let is_running = true;
	
			log('Waiting for parent process %d to terminate...', pid);
			while (is_running) {
				try {
					// Sending 0 as a signal does not kill the process, allowing for existence checking.
					// See: http://man7.org/linux/man-pages/man2/kill.2.html
					process.kill(pid, 0);
	
					// Introduce a small delay between checks.
					await Bun.sleep(500);
				} catch (e) {
					log('Parent process %d has terminated.', pid);
					is_running = false;
				}
			}
		} else {
			log('WARN: No parent PID was given to the updater.');
		}
	
		// We can never be 100% sure that the entire process tree terminated.
		// To that end, send an OS specific termination command.
		let command = [];
		switch (process.platform) {
			case 'win32':
				command = ['taskkill', '/f', '/im', 'wow.export.exe'];
				break;
			default: // linux, darwin
				command = ['pkill', '-f', 'wow.export'];
				break;
		}
	
		log('Sending auxiliary termination command (%s) %s', process.platform, command);
		const proc = Bun.spawn(command);
		await proc.exited;
	
		const install_dir = path.dirname(path.resolve(process.execPath));
		const update_dir = path.join(install_dir, '.update');
	
		log('Install directory: %s', install_dir);
		log('Update directory: %s', update_dir);
	
		if (await file_exists(update_dir)) {
			const update_stats = await fsp.lstat(update_dir);
			if (!update_stats.isDirectory() || update_stats.isSymbolicLink())
				throw new Error('Update path is not a safe directory.');
			await assert_update_path_contained(install_dir, update_dir);

			const update_files = await collect_files(update_dir);
			for (const file of update_files) {
				const relative_path = path.relative(update_dir, file).split(path.sep).join('/');
				const source_path = resolve_update_path(update_dir, relative_path);
				const write_path = resolve_update_path(install_dir, relative_path);

				await assert_update_path_contained(update_dir, source_path);
				await assert_update_path_contained(install_dir, write_path);
	
				log('Applying update file %s', write_path);
	
				try {
					let locked = (await file_exists(write_path)) && (await is_file_locked(write_path));
					let tries = 0;
	
					while (locked) {
						tries++;
	
						if (tries >= MAX_LOCK_TRIES)
							throw new Error('File was locked, MAX_LOCK_TRIES exceeded.');
	
						await Bun.sleep(1000);
						locked = await is_file_locked(write_path);
					}
	
					await assert_update_path_contained(update_dir, source_path);
					await assert_update_path_contained(install_dir, write_path);
					await fsp.mkdir(path.dirname(write_path), { recursive: true });
					await assert_update_path_contained(install_dir, write_path);
					await fsp.copyFile(source_path, write_path).catch(err => {
						log('WARN: Failed to write update file due to system error: %s', err.message);
					});
				} catch (e) {
					log('WARN: ' + e.message);
				}
			}
		} else {
			log('WARN: Update directory does not exist. No update to apply.');
		}
		
		const binary = process.platform === 'win32' ? 'wow.export.exe' : 'wow.export';
		log('Re-launching main process %s (%s)', binary, process.platform);
		if (binary) {
			const child = Bun.spawn([path.join(install_dir, binary)], {
				detached: true,
				stdio: ['ignore', 'ignore', 'ignore']
			});
			child.unref();
			log('wow.export has been updated, have fun!');
			await Bun.sleep(5000);
		}

		log('Removing update files...');
		delete_directory(update_dir);
	} catch (e) {
		console.error(e);
		log(e.message);
	} finally {
		const log_name = util.format('%s-update.log', Date.now());
		const log_path = path.resolve('./logs');
	
		await fsp.mkdir(log_path, { recursive: true });
		await fsp.writeFile(path.join(log_path, log_name), log_output.join('\n'), 'utf8');
	
		process.exit();
	}
})();
