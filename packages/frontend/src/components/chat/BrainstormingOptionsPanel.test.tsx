import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrainstormingOptionsPanel } from './BrainstormingOptionsPanel';
import type { BrainstormingOption } from '../../lib/types';

setupBrowserStubs();

test('BrainstormingOptionsPanel renders option cards and maturity labels', () => {
  const html = renderToStaticMarkup(
    <BrainstormingOptionsPanel options={options()} />,
  );

  assert.match(html, /推荐方案/);
  assert.match(html, /统一资源入口/);
  assert.match(html, /先定边界/);
  assert.match(html, /备选轻量方案/);
  assert.match(html, /可直接执行/);
  assert.match(html, /选择此方案/);
});

test('BrainstormingOptionsPanel marks selected options', () => {
  const html = renderToStaticMarkup(
    <BrainstormingOptionsPanel options={options()} selectedOptionIds={['recommended']} />,
  );

  assert.match(html, /已选择/);
  assert.match(html, /aria-pressed="true"/);
});

test('BrainstormingOptionsPanel invokes onSelect from button handler', () => {
  let selected: BrainstormingOption | null = null;
  const element = BrainstormingOptionsPanel({
    options: options(),
    onSelect: (option) => {
      selected = option;
    },
  });

  const button = findFirstElement(element, 'button');
  assert.ok(button);
  button.props.onClick();

  assert.ok(selected);
  assert.equal((selected as BrainstormingOption).id, 'recommended');
});

test('BrainstormingOptionsPanel does not invoke onSelect for selected option button', () => {
  const element = BrainstormingOptionsPanel({
    options: options(),
    selectedOptionIds: ['recommended'],
    onSelect: () => undefined,
  });

  const button = findFirstElement(element, 'button');
  assert.ok(button);
  assert.equal(button.props.disabled, true);
});

function options(): BrainstormingOption[] {
  return [
    {
      id: 'recommended',
      title: '推荐方案',
      summary: '统一资源入口',
      benefits: ['展示目录'],
      risks: ['需要确认边界'],
      maturity: 'boundary_needed',
      recommended: true,
    },
    {
      id: 'lightweight',
      title: '备选轻量方案',
      summary: '只修复空查询',
      benefits: [],
      risks: [],
      maturity: 'actionable',
    },
  ];
}

function findFirstElement(node: React.ReactNode, type: string): React.ReactElement | null {
  if (!React.isValidElement(node)) return null;
  if (node.type === type) return node;
  const children = React.Children.toArray(node.props.children);
  for (const child of children) {
    const found = findFirstElement(child, type);
    if (found) return found;
  }
  return null;
}

function setupBrowserStubs(): void {
  Object.assign(globalThis, { React });
}
