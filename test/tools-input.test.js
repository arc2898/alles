'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TOOL_SCHEMAS, buildToolSchemas, createToolExecutor } = require('../src/main/tools');

/** Fakes that record what the executor asks the input layer to do, including the picture size it hands over. */
function fakes({ scale = 0.5, width = 2000, height = 1000 } = {}) {
  const log = [];
  const input = {
    moveTo: async (x, y, o) => log.push(['moveTo', x, y, o]),
    click: async (b, o) => log.push(['click', b, !!(o && o.double)]),
    scroll: async (dx, dy) => log.push(['scroll', dx, dy]),
    drag: async (a, b, o) => log.push(['drag', a, b, o]),
    type: async (t, o) => { log.push(['type', t, o]); return fakes.typeResult === undefined ? { typed: [...t].length, notes: [] } : fakes.typeResult; },
    pressCombo: async (k) => log.push(['keys', k]),
  };
  const screen = { capture: async () => ({ png: Buffer.from('PNG'), scale, width, height, modelWidth: Math.round(width * scale), modelHeight: Math.round(height * scale) }) };
  return { log, input, screen };
}
const withShot = async (opts) => { const f = fakes(opts); const exec = createToolExecutor({ input: f.input, screen: f.screen }); await exec('screenshot', {}); f.log.length = 0; return { ...f, exec }; };
const names = (schemas) => schemas.map((t) => t.function.name);
const schemaOf = (schemas, name) => schemas.find((t) => t.function.name === name).function;

// ------------------------------------------------------------------ the schemas

test('the default tool list is the plain-keyboard one, and every schema is valid with unique names', () => {
  assert.deepStrictEqual(TOOL_SCHEMAS, buildToolSchemas());
  assert.deepStrictEqual(TOOL_SCHEMAS, buildToolSchemas({ unicode: false }));
  for (const schemas of [buildToolSchemas({ unicode: false }), buildToolSchemas({ unicode: true })]) {
    assert.strictEqual(new Set(names(schemas)).size, schemas.length);
    for (const t of schemas) {
      assert.strictEqual(t.type, 'function');
      assert.strictEqual(t.function.parameters.type, 'object');
      assert.ok(t.function.description.length >= 10, `${t.function.name} is described`);
      for (const r of t.function.parameters.required) assert.ok(r in t.function.parameters.properties, `${t.function.name}.${r}`);
    }
  }
});

test('the two lists differ ONLY in type_text, and each tells the model the truth about what it can enter', () => {
  const a = buildToolSchemas({ unicode: false }); const u = buildToolSchemas({ unicode: true });
  assert.deepStrictEqual(names(a), names(u));
  for (const n of names(a)) if (n !== 'type_text') assert.deepStrictEqual(schemaOf(a, n), schemaOf(u, n), n);
  const ta = schemaOf(a, 'type_text'); const tu = schemaOf(u, 'type_text');
  assert.match(ta.description, /US-keyboard/);
  assert.match(ta.description, /rejected/);
  assert.match(ta.description, /newline/i);
  assert.doesNotMatch(ta.description, /paste|clipboard/i, 'the plain version must not promise pasting');
  assert.deepStrictEqual(Object.keys(ta.parameters.properties), ['text']);
  assert.match(tu.description, /pasting/);
  assert.match(tu.description, /clipboard/);
  assert.match(tu.description, /terminal/i);
  assert.deepStrictEqual(Object.keys(tu.parameters.properties).sort(), ['terminal', 'text']);
  assert.strictEqual(tu.parameters.properties.terminal.type, 'boolean');
  assert.deepStrictEqual(tu.parameters.required, ['text']);
  assert.doesNotMatch(tu.description, /rejected/, 'the Unicode version does not reject accents');
});

test('mouse_scroll and mouse_drag are offered, with the right required fields', () => {
  const s = schemaOf(buildToolSchemas(), 'mouse_scroll');
  assert.deepStrictEqual(s.parameters.required, ['direction']);
  assert.deepStrictEqual(s.parameters.properties.direction.enum, ['up', 'down', 'left', 'right']);
  assert.strictEqual(s.parameters.properties.amount.type, 'number');
  const d = schemaOf(buildToolSchemas(), 'mouse_drag');
  assert.deepStrictEqual(d.parameters.required, ['from_x', 'from_y', 'to_x', 'to_y']);
  assert.deepStrictEqual(d.parameters.properties.button.enum, ['left', 'right', 'middle']);
});

// ------------------------------------------------------------------ the picture size travels with every coordinate

test('coordinates go to the input layer in real pixels, with the size of the picture they came from', async () => {
  const { log, exec } = await withShot({ scale: 0.5, width: 2000, height: 1000 });
  await exec('mouse_move', { x: 100, y: 50 });
  await exec('mouse_click', { x: 10, y: 20, button: 'right', double: true });
  assert.deepStrictEqual(log, [
    ['moveTo', 200, 100, { space: { width: 2000, height: 1000 } }],
    ['moveTo', 20, 40, { space: { width: 2000, height: 1000 } }],
    ['click', 'right', true],
  ]);
});

test('a capture that does not say its size passes no size (the input layer then uses the screen itself)', async () => {
  const f = { log: [] };
  const input = { moveTo: async (x, y, o) => f.log.push([x, y, o]) };
  const screen = { capture: async () => ({ png: Buffer.from('P'), scale: 1, modelWidth: 10, modelHeight: 10 }) };
  const exec = createToolExecutor({ input, screen });
  await exec('screenshot', {});
  await exec('mouse_move', { x: 3, y: 4 });
  assert.deepStrictEqual(f.log, [[3, 4, {}]]);
});

// ------------------------------------------------------------------ mouse_scroll

test('mouse_scroll: down 5 notches by default, where the pointer already is (no move, no screenshot needed)', async () => {
  const f = fakes();
  const exec = createToolExecutor({ input: f.input, screen: f.screen });
  const r = await exec('mouse_scroll', { direction: 'down' });
  assert.deepStrictEqual(f.log, [['scroll', 0, 5]]);
  assert.strictEqual(r.error, undefined);
  assert.match(r.text, /Scrolled down 5 notches/);
});

test('mouse_scroll: each direction, any capitalisation, and the amount', async () => {
  const { log, exec } = await withShot();
  await exec('mouse_scroll', { direction: 'up', amount: 3 });
  await exec('mouse_scroll', { direction: 'LEFT', amount: 2 });
  await exec('mouse_scroll', { direction: 'Right', amount: 4 });
  await exec('mouse_scroll', { direction: 'down', amount: 7 });
  assert.deepStrictEqual(log, [['scroll', 0, -3], ['scroll', -2, 0], ['scroll', 4, 0], ['scroll', 0, 7]]);
});

test('mouse_scroll: the amount is a whole number from 1 to 50; anything odd means the default 5', async () => {
  const { log, exec } = await withShot();
  for (const amount of [0, -4, 0.4, 2.6, 999, 50, 51, 'abc', NaN, null, undefined, Infinity, '8']) await exec('mouse_scroll', { direction: 'down', amount });
  assert.deepStrictEqual(log.map((e) => e[2]), [1, 1, 1, 3, 50, 50, 50, 5, 5, 5, 5, 5, 8]);
});

test('mouse_scroll: with x and y it moves there first (in real pixels, with the picture size), then turns the wheel', async () => {
  const { log, exec } = await withShot({ scale: 0.5, width: 2000, height: 1000 });
  const r = await exec('mouse_scroll', { x: 100, y: 60, direction: 'up', amount: 2 });
  assert.deepStrictEqual(log, [['moveTo', 200, 120, { space: { width: 2000, height: 1000 } }], ['scroll', 0, -2]]);
  assert.match(r.text, /Scrolled up 2 notches at \(100, 60\)/);
});

test('mouse_scroll: a point needs a screenshot first, but scrolling in place does not', async () => {
  const f = fakes();
  const exec = createToolExecutor({ input: f.input, screen: f.screen });
  const r = await exec('mouse_scroll', { x: 1, y: 1, direction: 'down' });
  assert.ok(r.error && /Take a screenshot first/.test(r.text));
  assert.deepStrictEqual(f.log, []);
});

test('mouse_scroll: x without y (or y without x) is refused and nothing moves', async () => {
  const { log, exec } = await withShot();
  for (const args of [{ x: 5, direction: 'down' }, { y: 5, direction: 'down' }]) {
    const r = await exec('mouse_scroll', args);
    assert.ok(r.error && /both x and y/.test(r.text), JSON.stringify(args));
  }
  assert.deepStrictEqual(log, []);
});

test('mouse_scroll: a point may be zero (the corner of the screen is a place)', async () => {
  const { log, exec } = await withShot({ scale: 1 });
  await exec('mouse_scroll', { x: 0, y: 0, direction: 'down', amount: 1 });
  assert.deepStrictEqual(log[0].slice(0, 3), ['moveTo', 0, 0]);
});

test('mouse_scroll: a missing or unknown direction is explained, and nothing is sent', async () => {
  const { log, exec } = await withShot();
  for (const direction of [undefined, '', 'sideways', 5, null]) {
    const r = await exec('mouse_scroll', { direction });
    assert.ok(r.error && /direction must be "up", "down", "left" or "right"/.test(r.text), String(direction));
  }
  assert.deepStrictEqual(log, []);
});

test('mouse_scroll: one notch reads naturally', async () => {
  const { exec } = await withShot();
  assert.match((await exec('mouse_scroll', { direction: 'down', amount: 1 })).text, /Scrolled down 1 notch$/);
});

test('mouse_scroll: a refusal from the input layer (emergency stop) reaches the model as an error', async () => {
  const input = { scroll: async () => { throw new Error('Emergency stop is engaged - agent input is disabled'); } };
  const r = await createToolExecutor({ input, screen: fakes().screen })('mouse_scroll', { direction: 'down' });
  assert.ok(r.error && /Emergency stop/.test(r.text));
});

// ------------------------------------------------------------------ mouse_drag

test('mouse_drag: both ends are converted to real pixels; the picture size and the button go along', async () => {
  const { log, exec } = await withShot({ scale: 0.5, width: 2000, height: 1000 });
  const r = await exec('mouse_drag', { from_x: 10, from_y: 20, to_x: 110, to_y: 220 });
  assert.deepStrictEqual(log, [['drag', { x: 20, y: 40 }, { x: 220, y: 440 }, { button: 'left', space: { width: 2000, height: 1000 } }]]);
  assert.match(r.text, /Dragged from \(10, 20\) to \(110, 220\)/);
  log.length = 0;
  await exec('mouse_drag', { from_x: 1, from_y: 2, to_x: 3, to_y: 4, button: 'right' });
  assert.strictEqual(log[0][3].button, 'right');
});

test('mouse_drag: needs a screenshot first, like every tool that takes coordinates', async () => {
  const f = fakes();
  const r = await createToolExecutor({ input: f.input, screen: f.screen })('mouse_drag', { from_x: 1, from_y: 1, to_x: 2, to_y: 2 });
  assert.ok(r.error && /Take a screenshot first/.test(r.text));
  assert.deepStrictEqual(f.log, []);
});

test('mouse_drag: a failure part-way is an error result, not an exception', async () => {
  const input = { drag: async () => { throw new Error('boom'); } };
  const exec = createToolExecutor({ input, screen: fakes().screen });
  await exec('screenshot', {});
  const r = await exec('mouse_drag', { from_x: 1, from_y: 1, to_x: 2, to_y: 2 });
  assert.ok(r.error && /boom/.test(r.text));
});

// ------------------------------------------------------------------ type_text

test('type_text: the text goes through, and only terminal:true (or the text "true") asks for the terminal paste shortcut', async () => {
  const { log, exec } = await withShot();
  await exec('type_text', { text: 'hello' });
  await exec('type_text', { text: 'ls', terminal: true });
  await exec('type_text', { text: 'ls', terminal: 'true' });
  for (const terminal of [false, 'false', 1, 'yes', null, 0, '']) await exec('type_text', { text: 'x', terminal });
  assert.deepStrictEqual(log[0], ['type', 'hello', undefined]);
  assert.deepStrictEqual(log[1], ['type', 'ls', { terminal: true }]);
  assert.deepStrictEqual(log[2], ['type', 'ls', { terminal: true }], 'a model that writes "true" means true');
  assert.ok(log.slice(3).every((e) => e[2] === undefined), 'anything else is ignored - above all the text "false", which is not a yes');
});

test('type_text: the model is told how many characters were typed and what was converted or pasted', async () => {
  const f = fakes();
  const exec = createToolExecutor({ input: f.input, screen: f.screen });
  fakes.typeResult = { typed: 4, notes: ['converted 1 typographic character(s) to plain equivalents', '1 character(s) the keyboard cannot type were pasted with Ctrl+V'] };
  const r = await exec('type_text', { text: 'abcd' });
  fakes.typeResult = undefined;
  assert.strictEqual(r.text, 'Typed 4 chars. Note: converted 1 typographic character(s) to plain equivalents; 1 character(s) the keyboard cannot type were pasted with Ctrl+V.');
});

test('type_text: the count comes from what the input layer says it typed (characters, not UTF-16 units)', async () => {
  const f = fakes();
  const exec = createToolExecutor({ input: f.input, screen: f.screen });
  assert.strictEqual('ab\u{1F600}'.length, 4);
  assert.strictEqual((await exec('type_text', { text: 'ab\u{1F600}' })).text, 'Typed 3 chars.');
  const exec2 = createToolExecutor({ input: { type: async () => ({ typed: 7, notes: [] }) }, screen: f.screen });
  assert.strictEqual((await exec2('type_text', { text: 'abc' })).text, 'Typed 7 chars.', 'the layer knows best what it typed');
  const exec3 = createToolExecutor({ input: { type: async () => ({ typed: NaN, notes: [] }) }, screen: f.screen });
  assert.strictEqual((await exec3('type_text', { text: 'abc' })).text, 'Typed 3 chars.', 'a count that is not a number is not shown');
});

test('type_text: with no notes there is no "Note:"; with no result object the length of the text is reported', async () => {
  const f = fakes();
  const exec = createToolExecutor({ input: f.input, screen: f.screen });
  assert.strictEqual((await exec('type_text', { text: 'abc' })).text, 'Typed 3 chars.');
  const exec2 = createToolExecutor({ input: { type: async () => undefined }, screen: f.screen });
  assert.strictEqual((await exec2('type_text', { text: 'abcde' })).text, 'Typed 5 chars.');
});

test('type_text: a text that is not a string is refused before anything is typed', async () => {
  const { log, exec } = await withShot();
  for (const text of [undefined, null, 5, {}, ['a']]) {
    const r = await exec('type_text', { text });
    assert.ok(r.error && /needs a "text" string/.test(r.text), String(text));
  }
  assert.deepStrictEqual(log, []);
});

test('type_text: a rejection from the input layer (a character that cannot be entered) is passed to the model', async () => {
  const input = { type: async () => { throw new Error('Cannot type 1 kind(s) of character with the keyboard tool: "é" (U+00E9). Nothing was typed.'); } };
  const r = await createToolExecutor({ input, screen: fakes().screen })('type_text', { text: 'é' });
  assert.ok(r.error && /Nothing was typed/.test(r.text));
});
