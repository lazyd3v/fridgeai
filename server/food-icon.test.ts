import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FoodIcon } from '../src/ui.tsx';

const render = (name: string, icon?: string | null) => renderToStaticMarkup(createElement(FoodIcon, { name, icon }));
test('saved choices take precedence and pineapple never falls through to the apple legacy rule', () => {
  assert.doesNotMatch(render('Pineapple slices'), /<img/);
  assert.doesNotMatch(render('Eggplant'), /<img/);
  assert.match(render('Apples'), /apple.png/);
  assert.match(render('Slices', 'pineapple'), /pineapple.png/);
  assert.doesNotMatch(render('Apples', 'none'), /<img/);
  assert.doesNotMatch(render('Apples', '../apple'), /<img/);
});
