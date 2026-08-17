/** Saving and sharing the exported photo/video. */

export function timestampName(prefix: string, extension: string): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}-${stamp}.${extension}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function canShareFile(blob: Blob, filename: string): boolean {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false;
  try {
    const file = new File([blob], filename, { type: blob.type });
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Returns false when sharing is unavailable so the caller can fall back. */
export async function shareBlob(blob: Blob, filename: string, title: string): Promise<boolean> {
  if (!canShareFile(blob, filename)) return false;
  try {
    const file = new File([blob], filename, { type: blob.type });
    await navigator.share({ files: [file], title });
    return true;
  } catch (err) {
    // AbortError just means the user dismissed the sheet.
    if ((err as { name?: string })?.name === 'AbortError') return true;
    return false;
  }
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
