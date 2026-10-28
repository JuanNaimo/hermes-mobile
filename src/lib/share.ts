import { isNativeApp } from "./http.ts";

/**
 * Hand a file to the person: the share sheet where there is one (the app,
 * mobile browsers), a download in desktop browsers. Returns false when
 * neither works, so the caller can fall back (e.g. to the clipboard).
 */
export async function shareOrDownload(file: File): Promise<boolean> {
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: file.name });
    return true;
  }
  if (!isNativeApp()) {
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  return false;
}

export async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type });
}
