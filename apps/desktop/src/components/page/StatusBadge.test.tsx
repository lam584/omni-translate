import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import StatusBadge from './StatusBadge';

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
