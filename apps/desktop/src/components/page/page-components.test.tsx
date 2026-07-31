import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PageSectionHeader from './PageSectionHeader';
import StatusBadge from './StatusBadge';

describe('page components', () => {
  describe('StatusBadge', () => {
    it('renders the tone class without pulse by default', () => {
      const markup = renderToStaticMarkup(<StatusBadge label="就绪" tone="ready" />);
      expect(markup).toContain('status-badge');
      expect(markup).toContain('status-badge-ready');
      expect(markup).not.toContain('status-badge-pulse');
    });

    it('applies the pulse class when pulse is true', () => {
      const markup = renderToStaticMarkup(<StatusBadge label="采集中" pulse tone="ready" />);
      expect(markup).toContain('status-badge-pulse');
    });

    it('omits the pulse class when pulse is false', () => {
      const markup = renderToStaticMarkup(<StatusBadge label="空闲" pulse={false} tone="pending" />);
      expect(markup).not.toContain('status-badge-pulse');
    });
  });

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
});
