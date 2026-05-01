// pdfjs-dist is browser-only. Import it lazily so the SSR server build never
// touches it. The worker is served from /public as a plain static asset.

let workerInitialised = false;

async function getPdfjsLib() {
  const pdfjsLib = await import('pdfjs-dist');
  if (!workerInitialised) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
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

    return pageTexts.join('\n\n');
  }

  return file.text();
}
