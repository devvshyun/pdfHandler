// Builds a small sample PDF in the browser so the editor can open in a working state.
import { applyOperations, type PdfOperation } from '@pdfhandler/core';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { rasterText } from './raster';

const PAGES: Array<{ size: [number, number]; heading: string; lines: string[]; english: string }> = [
  {
    size: [595, 842],
    heading: 'pdfHandler 샘플 문서',
    lines: [
      '이 문서는 브라우저 안에서 만들어졌습니다.',
      '',
      '해 볼 만한 것',
      '· 왼쪽 썸네일을 드래그해 쪽 순서 바꾸기',
      '· 위쪽 도구로 회전, 삭제, 병합, 분할',
      '· 텍스트, 펜, 형광펜으로 주석 달기',
      '· 워터마크와 쪽 번호 넣기',
      '· 오른쪽 위 검색창에서 "invoice" 검색',
    ],
    english: 'Sample page 1 - quarterly report draft',
  },
  {
    size: [595, 842],
    heading: '2쪽 · 견적 요약',
    lines: ['항목               수량      금액', '디자인 검토          3     1,200,000원', 'PDF 변환 작업        12      480,000원', '합계                        1,680,000원'],
    english: 'Sample page 2 - invoice summary',
  },
  {
    size: [842, 595],
    heading: '3쪽 · 가로 방향 쪽',
    lines: ['회전 버튼으로 세로로 돌려 보세요.'],
    english: 'Sample page 3 - landscape appendix',
  },
];

export async function buildSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('pdfHandler 샘플');
  doc.setAuthor('pdfHandler');
  for (const p of PAGES) {
    const page = doc.addPage(p.size);
    page.drawRectangle({ x: 0, y: p.size[1] - 8, width: p.size[0], height: 8, color: rgb(0.85, 0.19, 0.15) });
    // Real (selectable, searchable) text in a standard font.
    page.drawText(p.english, { x: 56, y: 48, size: 11, font, color: rgb(0.4, 0.4, 0.45) });
  }
  // Korean lines are rasterised, the same way the editor's text tool works.
  const ops: PdfOperation[] = [];
  for (const [i, p] of PAGES.entries()) {
    const heading = await rasterText(p.heading, 26, '#1f2328', true);
    ops.push({ type: 'addImage', page: i, x: 56, y: 64, width: heading.width, height: heading.height, imageBase64: heading.base64 });
    const body = await rasterText(p.lines.join('\n'), 14, '#3d434b');
    ops.push({ type: 'addImage', page: i, x: 56, y: 120, width: body.width, height: body.height, imageBase64: body.base64 });
  }
  return applyOperations(await doc.save(), ops);
}
