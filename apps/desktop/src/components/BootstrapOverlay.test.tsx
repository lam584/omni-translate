import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BootstrapOverlay, { type BootstrapStep } from './BootstrapOverlay';

describe('BootstrapOverlay', () => {
  const steps: BootstrapStep[] = [
    { id: 'runtime', label: 'Runtime', status: 'done' },
    { id: 'audio', label: 'Audio', status: 'active', detail: 'Loading devices' },
    { id: 'config', label: 'Config', status: 'pending' },
    { id: 'bridge', label: 'Bridge', status: 'error', detail: 'Unavailable' },
  ];

  it('does not render when hidden', () => {
    expect(renderToStaticMarkup(<BootstrapOverlay visible={false} steps={steps} />)).toBe('');
  });

  it('renders every startup step with status classes and optional detail', () => {
    const markup = renderToStaticMarkup(<BootstrapOverlay visible steps={steps} />);

    expect(markup).toContain('bootstrap-overlay');
    expect(markup).toContain('bootstrap-step-done');
    expect(markup).toContain('bootstrap-step-active');
    expect(markup).toContain('bootstrap-step-pending');
    expect(markup).toContain('bootstrap-step-error');
    expect(markup).toContain('Runtime');
    expect(markup).toContain('Loading devices');
    expect(markup).toContain('Unavailable');
    expect(markup).toContain('<svg');
  });
});
