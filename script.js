import * as pdfjsLib from './lib/pdfjs/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdfjs/build/pdf.worker.mjs', import.meta.url).href;

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fileInput = $('pdfFile');
  const dropzone = $('dropzone');
  const convertBtn = $('convertBtn');
  const statusEl = $('status');
  const fileInfo = $('fileInfo');
  const progressTrack = $('progressTrack');
  const progressBar = $('progressBar');
  const resultSection = $('resultSection');
  const output = $('output');
  let selectedFile = null;
  let outputName = 'converted.md';
  let ocrWorkerPromise = null;

  function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
  }
  function setProgress(value) {
    progressTrack.classList.remove('hidden');
    progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }
  function formatSize(bytes) {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  function chooseFile(file) {
    if (!file) return;
    if (!(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
      setStatus('الرجاء اختيار ملف PDF فقط.', true); return;
    }
    selectedFile = file;
    fileInfo.textContent = `${file.name} · ${formatSize(file.size)}`;
    fileInfo.classList.remove('hidden');
    convertBtn.disabled = false;
    resultSection.classList.add('hidden');
    setStatus('الملف جاهز. اضغط على زر التحويل.');
    progressTrack.classList.add('hidden'); progressBar.style.width = '0';
    outputName = file.name.replace(/\.pdf$/i, '') + '.md';
  }
  fileInput.addEventListener('change', e => chooseFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, e => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', e => chooseFile(e.dataTransfer.files[0]));

  function normalizeText(text) {
    return String(text || '')
      .normalize('NFKC') // Convert Arabic presentation forms to normal Unicode letters.
      .replace(/[\u0000\u200B-\u200F\uFEFF]/g, '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Group PDF.js fragments by visual line and infer spaces from their actual positions.
  // PDF.js may return Arabic letters as separate fragments; blindly joining with spaces
  // produces output such as ا ل ت س ج ي ل. This routine joins adjacent glyphs when the
  // geometric gap is small, while retaining larger gaps between words.
  function extractPageText(items, improveArabicOrder) {
    const fragments = items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => ({
      text: item.str.normalize('NFKC').trim(),
      x: item.transform ? item.transform[4] : 0,
      y: item.transform ? item.transform[5] : 0,
      width: Math.abs(item.width || 0),
      height: Math.abs(item.height || (item.transform ? item.transform[3] : 0) || 0)
    }));
    if (!fragments.length) return '';
    fragments.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const frag of fragments) {
      const tolerance = Math.max(2.5, frag.height * 0.35);
      let line = lines.find(candidate => Math.abs(candidate.y - frag.y) <= Math.max(tolerance, candidate.height * 0.35));
      if (!line) { line = { y: frag.y, height: frag.height, items: [] }; lines.push(line); }
      line.items.push(frag);
      const n = line.items.length;
      line.y = (line.y * (n - 1) + frag.y) / n;
      line.height = Math.max(line.height, frag.height);
    }
    lines.sort((a, b) => b.y - a.y);
    return lines.map(line => {
      const joined = line.items.map(i => i.text).join('');
      const arabicChars = (joined.match(/[\u0600-\u06FF]/g) || []).length;
      const latinChars = (joined.match(/[A-Za-z0-9]/g) || []).length;
      const rtlLine = improveArabicOrder && arabicChars > latinChars;
      line.items.sort((a, b) => rtlLine ? b.x - a.x : a.x - b.x);
      if (line.items.length === 1) return line.items[0].text;
      let result = '';
      let previous = null;
      for (const item of line.items) {
        if (!previous) {
          result = item.text;
          previous = item;
          continue;
        }
        // Estimate the empty horizontal gap between neighboring text fragments.
        const gap = rtlLine
          ? previous.x - (item.x + item.width)
          : item.x - (previous.x + previous.width);
        const fontHeight = Math.max(1, previous.height, item.height, line.height * 0.6);
        const tinyFragments = previous.text.length <= 2 && item.text.length <= 2;
        const noSpace = tinyFragments && gap <= Math.max(1.5, fontHeight * 0.12);
        const alreadyHasSpace = /\s$/.test(result) || /^\s/.test(item.text);
        if (!alreadyHasSpace && !noSpace) result += ' ';
        result += item.text;
        previous = item;
      }
      return result.replace(/[ \t]+/g, ' ').trim();
    }).filter(Boolean).join('\n');
  }

  function toMarkdown(text, fileName) {
    const cleaned = normalizeText(text);
    if (!cleaned) return `# ${fileName}\n\nلم يتم العثور على نص قابل للاستخراج.`;
    const blocks = cleaned.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
    const formatted = blocks.map(block => {
      const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
      if (lines.length === 1 && lines[0].length < 85 && /^(الفصل|المقدمة|المحتويات|الملخص|مقدمة|الخاتمة|Chapter|Introduction|Conclusion|Contents|Executive Summary)\b/i.test(lines[0])) return `## ${lines[0]}`;
      return lines.join('\n');
    });
    return `# ${fileName.replace(/\.pdf$/i, '')}\n\n${formatted.join('\n\n')}\n`;
  }

  async function getOcrWorker(lang) {
    if (!window.Tesseract) throw new Error('لم يتم تحميل Tesseract.js. تحقق من اتصال الإنترنت ثم أعد المحاولة.');
    if (ocrWorkerPromise && ocrWorkerPromise.lang === lang) return ocrWorkerPromise.promise;
    if (ocrWorkerPromise) { try { (await ocrWorkerPromise.promise).terminate(); } catch (_) {} }
    const options = {
      langPath: new URL('./lib/tesseract/lang/', window.location.href).href,
      gzip: false,
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5',
      logger: m => {
        if (m.status) {
          const pct = typeof m.progress === 'number' ? ` ${Math.round(m.progress * 100)}%` : '';
          setStatus(`تجهيز OCR: ${m.status}${pct}`);
        }
      }
    };
    const promise = window.Tesseract.createWorker(lang, 1, options);
    ocrWorkerPromise = { lang, promise };
    return promise;
  }

  async function runOcr(pdf, pageNumber, lang) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const worker = await getOcrWorker(lang);
    const result = await worker.recognize(canvas);
    canvas.width = 0; canvas.height = 0;
    return result.data.text || '';
  }

  convertBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    convertBtn.disabled = true; fileInput.disabled = true;
    resultSection.classList.add('hidden'); setProgress(2); setStatus('جارٍ قراءة ملف PDF…');
    try {
      const bytes = new Uint8Array(await selectedFile.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      const allPages = [];
      const useOcr = $('useOcr').checked;
      const improveArabicOrder = $('arabicMode').checked;
      const lang = $('ocrLanguage').value;
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        setStatus(`معالجة الصفحة ${pageNum} من ${pdf.numPages}…`);
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        let pageText = normalizeText(extractPageText(content.items, improveArabicOrder));
        if (useOcr && pageText.replace(/\s/g, '').length < 25) {
          setStatus(`الصفحة ${pageNum}: لا يوجد نص كافٍ، جارٍ تجربة OCR…`);
          pageText = await runOcr(pdf, pageNum, lang);
        }
        allPages.push(`<!-- الصفحة ${pageNum} -->\n\n${pageText}`);
        setProgress(10 + (pageNum / pdf.numPages) * 85);
      }
      output.value = toMarkdown(allPages.join('\n\n'), selectedFile.name);
      resultSection.classList.remove('hidden'); setProgress(100);
      setStatus(`اكتمل التحويل (${pdf.numPages} صفحة). راجع النص قبل تنزيله.`);
      resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      setStatus(`تعذّر التحويل: ${err?.message || 'خطأ غير معروف'}`, true);
    } finally { convertBtn.disabled = !selectedFile; fileInput.disabled = false; }
  });

  $('downloadBtn').addEventListener('click', () => {
    const blob = new Blob(['\uFEFF', output.value], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = outputName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
