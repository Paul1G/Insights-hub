// Copied from apps/web/src/domain/mime.ts so the proxy applies the same
// extension <-> content-type check as the studio before uploading.

// File content-type <-> extension rules.
//
// The Asset Management file upload validates that the multipart content-type
// matches the file name extension ('to ensure no malicious file is being
// uploaded'). The platform does not publish its exact table, so this map uses
// the standard IANA media types for common engineering/document formats; a
// file is accepted when its content-type is one of the types registered for
// its extension.

const MIME_BY_EXTENSION: Record<string, string[]> = {
  txt: ['text/plain'],
  csv: ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
  json: ['application/json'],
  xml: ['application/xml', 'text/xml'],
  yaml: ['application/yaml', 'application/x-yaml', 'text/yaml'],
  yml: ['application/yaml', 'application/x-yaml', 'text/yaml'],
  md: ['text/markdown', 'text/plain'],
  html: ['text/html'],
  htm: ['text/html'],
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  bmp: ['image/bmp'],
  svg: ['image/svg+xml'],
  webp: ['image/webp'],
  tif: ['image/tiff'],
  tiff: ['image/tiff'],
  zip: ['application/zip', 'application/x-zip-compressed'],
  gz: ['application/gzip'],
  doc: ['application/msword'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  mp4: ['video/mp4'],
  mp3: ['audio/mpeg'],
  wav: ['audio/wav', 'audio/x-wav'],
};

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function knownExtensions(): string[] {
  return Object.keys(MIME_BY_EXTENSION);
}

/** Preferred content-type for a file name, if the extension is known. */
export function mimeForFileName(fileName: string): string | undefined {
  return MIME_BY_EXTENSION[fileExtension(fileName)]?.[0];
}

export type MimeCheck =
  | { ok: true }
  | {
      ok: false;
      reason: 'no-extension' | 'unknown-extension' | 'mismatch';
      expected?: string[];
    };

/** Check that a content-type is consistent with the file name's extension. */
export function checkContentType(
  fileName: string,
  mimeType: string,
): MimeCheck {
  const ext = fileExtension(fileName);
  if (!ext) return { ok: false, reason: 'no-extension' };
  const expected = MIME_BY_EXTENSION[ext];
  if (!expected) return { ok: false, reason: 'unknown-extension' };
  const normalized = mimeType.split(';')[0]!.trim().toLowerCase();
  return expected.includes(normalized)
    ? { ok: true }
    : { ok: false, reason: 'mismatch', expected };
}
