import assert from 'node:assert/strict';
import { parseHex, toHex } from '../src/lib/color.ts';
for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF', '#000000', '#818181', '#A0B1C280', '#00000000']) {
  assert.equal(toHex(parseHex(hex)!), hex);
}
assert.equal(toHex(parseHex('#abc')!), '#AABBCC');
assert.equal(toHex(parseHex('#abcd')!), '#AABBCCDD');
for (const hex of ['', 'GGGGGG', '12345', '1234567', '#123456789']) assert.equal(parseHex(hex), null);
assert.equal(toHex({h: 360, s: 1, v: 1, a: 1}), '#FF0000');
assert.equal(toHex({h: 240, s: 0, v: .5, a: .5}), '#80808080');
console.log('Color conversion, shorthand, transparency, grayscale, and invalid input checks passed.');
