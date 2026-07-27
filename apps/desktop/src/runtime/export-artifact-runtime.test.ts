import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    capabilities: { hasNativeShell: false },
    diagnostics: { writeExportArtifact: vi.fn() },
  },
}));

vi.mock('./desktop-api', () => ({
  activeDesktopApi: () => mocks.api,
}));

import { writeExportArtifactRuntime } from './export-artifact-runtime';

describe('export artifact runtime', () => {
  beforeEach(() => {
    mocks.api.capabilities.hasNativeShell = false;
    mocks.api.diagnostics.writeExportArtifact.mockReset();
    vi.restoreAllMocks();
  });

  it('delegates native exports and returns the native receipt', async () => {
    mocks.api.capabilities.hasNativeShell = true;
    mocks.api.diagnostics.writeExportArtifact.mockResolvedValue({
      outputPath: 'C:/exports/report.json',
      fileCount: 1,
    });

    await expect(writeExportArtifactRuntime('report.json', '{}', 'application/json')).resolves.toEqual({
      outputPath: 'C:/exports/report.json',
      fileCount: 1,
    });
    expect(mocks.api.diagnostics.writeExportArtifact).toHaveBeenCalledWith('report.json', '{}');
  });

  it('downloads browser artifacts and revokes the object URL after the click', async () => {
    vi.useFakeTimers();
    try {
      const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
      const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
      const click = vi.fn();
      vi.spyOn(document, 'createElement').mockReturnValue({ click } as unknown as HTMLAnchorElement);

      await expect(writeExportArtifactRuntime('report.csv', 'a,b', 'text/csv')).resolves.toEqual({
        outputPath: 'report.csv',
        fileCount: 1,
      });
      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      expect(click).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
    } finally {
      vi.useRealTimers();
    }
  });

  it('immediately revokes the browser URL when starting the download fails', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:failed');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('document unavailable');
    });

    await expect(writeExportArtifactRuntime('report.csv', 'a,b', 'text/csv')).rejects.toThrow(
      'document unavailable',
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed');
  });
});
