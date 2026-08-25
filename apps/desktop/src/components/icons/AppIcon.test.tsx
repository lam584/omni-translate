import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AppIcon, { type AppIconName } from './AppIcon';

describe('AppIcon', () => {
  it.each([
    'arrow-left',
    'arrow-right',
    'chip',
    'diagnostics',
    'edit',
    'export',
    'globe',
    'import',
    'panel',
    'plus',
    'power',
    'route',
    'save',
    'server',
    'translate',
  ] satisfies AppIconName[])('renders the %s icon', (name) => {
    expect(renderToStaticMarkup(<AppIcon name={name} />)).toContain('<svg');
  });

  it('falls back to a circle for an unknown icon name', () => {
    expect(renderToStaticMarkup(<AppIcon name={'unknown' as AppIconName} />)).toContain('<circle');
  });
});
