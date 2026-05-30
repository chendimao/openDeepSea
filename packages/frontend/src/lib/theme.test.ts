import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME_MODE, parseThemeMode } from './theme';

test('parseThemeMode defaults to minimal light theme', () => {
  assert.equal(DEFAULT_THEME_MODE, 'minimal-light');
  assert.equal(parseThemeMode(null), 'minimal-light');
  assert.equal(parseThemeMode(''), 'minimal-light');
});

test('parseThemeMode migrates legacy light themes to minimal light', () => {
  assert.equal(parseThemeMode('light'), 'minimal-light');
  assert.equal(parseThemeMode('minimal'), 'minimal-light');
  assert.equal(parseThemeMode('console'), 'minimal-light');
});

test('parseThemeMode keeps explicit combined theme selections', () => {
  assert.equal(parseThemeMode('apple-light'), 'apple-light');
  assert.equal(parseThemeMode('apple-dark'), 'apple-dark');
  assert.equal(parseThemeMode('minimal-dark'), 'minimal-dark');
});
