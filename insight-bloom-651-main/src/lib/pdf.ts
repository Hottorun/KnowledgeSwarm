// Vite resolves ?url imports to the correct dev/prod asset URL at build time.
// This is a plain string — safe to import at module level even in SSR.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let workerInitialised = false;

async function getPdfjsLib() {
  const pdfjsLib = await import('pdfjs-dist');
  if (!workerInitialised) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    workerInitialised = true;
  }
  return pdfjsLib;
}

export async function extractFileText(file: File): Promise<string> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const pdfjsLib = await getPdfjsLib();
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

    const pageTexts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map(item => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (pageText) pageTexts.push(pageText);
    }

    const result = pageTexts.join('\n\n');
    if (!result.trim()) throw new Error('PDF has no extractable text (may be image-based or scanned)');
    return result;
  }

  return file.text();
}
