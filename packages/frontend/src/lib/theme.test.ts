import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME_MODE, parseThemeMode } from './theme';

test('parseThemeMode defaults to apple light theme', () => {
  assert.equal(DEFAULT_THEME_MODE, 'apple-light');
  assert.equal(parseThemeMode(null), 'apple-light');
  assert.equal(parseThemeMode(''), 'apple-light');
});

test('parseThemeMode migrates legacy theme names', () => {
  assert.equal(parseThemeMode('light'), 'apple-light');
  assert.equal(parseThemeMode('minimal'), 'minimal-light');
  assert.equal(parseThemeMode('console'), 'minimal-light');
});

test('parseThemeMode keeps explicit combined theme selections', () => {
  assert.equal(parseThemeMode('apple-light'), 'apple-light');
  assert.equal(parseThemeMode('apple-dark'), 'apple-dark');
  assert.equal(parseThemeMode('minimal-dark'), 'minimal-dark');
});
