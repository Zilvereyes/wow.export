import { expect, test } from 'bun:test';
import { parse_xml } from '../src/js/xml.js';

test('rejects top-level text that cannot advance the parser', () => {
	expect(() => parse_xml('text<SavedCharacter/>'))
		.toThrow('invalid XML: parser made no progress');
});

test('rejects text nodes that cannot advance the parser', () => {
	expect(() => parse_xml('<SavedCharacter version="2.0">text</SavedCharacter>'))
		.toThrow('invalid XML: parser made no progress');
});

test('rejects unsupported attribute syntax that cannot advance the parser', () => {
	expect(() => parse_xml('<SavedCharacter !></SavedCharacter>'))
		.toThrow('invalid XML: parser made no progress');
});

test('preserves supported WMV XML parsing', () => {
	const parsed = parse_xml(`<?xml version="1.0"?>
		<SavedCharacter version="2.0">
			<model>
				<file name="Character\\Human\\Male\\HumanMale.m2"/>
			</model>
			<equipment>
				<item><id value="123"/></item>
				<item><id value="456"/></item>
			</equipment>
		</SavedCharacter>
	`);

	expect(parsed).toEqual({
		'?xml': { '@_version': '1.0' },
		SavedCharacter: {
			'@_version': '2.0',
			model: {
				file: { '@_name': 'Character\\Human\\Male\\HumanMale.m2' }
			},
			equipment: {
				item: [
					{ id: { '@_value': '123' } },
					{ id: { '@_value': '456' } }
				]
			}
		}
	});
});
