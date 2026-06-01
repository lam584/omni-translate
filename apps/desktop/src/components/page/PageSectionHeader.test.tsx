import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PageSectionHeader from './PageSectionHeader';

describe('PageSectionHeader', () => {
  it('renders copy, actions and custom heading levels', () => {
    const markup = renderToStaticMarkup(
      <PageSectionHeader actions={<button type="button">save</button>} description="details" title="heading" titleLevel="h2" />,
    );

    expect(markup).toContain('<h2>heading</h2>');
    expect(markup).toContain('<p>details</p>');
    expect(markup).toContain('<button');
  });

  it('renders description without a title and allows an empty header', () => {
    expect(renderToStaticMarkup(<PageSectionHeader description="details" />)).toContain('<p>details</p>');
    expect(renderToStaticMarkup(<PageSectionHeader />)).toBe('<div class="page-section-header"></div>');
  });
});
