import { activeDesktopApi } from './desktop-api';

export type ExportArtifactReceipt = { outputPath: string; fileCount: number };

export async function writeExportArtifactRuntime(
  filename: string,
  content: string,
  mimeType: string,
): Promise<ExportArtifactReceipt> {
  if (activeDesktopApi().capabilities.hasNativeShell) {
    return activeDesktopApi().diagnostics.writeExportArtifact(filename, content);
  }
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return { outputPath: filename, fileCount: 1 };
}
