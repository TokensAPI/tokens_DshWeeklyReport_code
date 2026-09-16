import { PDFDocument } from 'pdf-lib';

// Rasterize with local system fonts so Chinese preview needs no downloaded font or server.
// This is a real, downloadable PDF of the current demo draft, not the production renderer.
export async function renderDemoPdf(draft) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(draft.title + ' (DEMO)');
  const width = 1240, height = 1754, margin = 90;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  let y, pageNumber = 0;
  const begin = () => {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#63756a'; ctx.font = '24px "Microsoft YaHei", sans-serif';
    ctx.fillText('周报 · 本地演示 / 全部为模拟数据', margin, 60); y = 130;
  };
  const finish = async () => {
    ctx.fillStyle = '#63756a'; ctx.font = '22px sans-serif';
    ctx.fillText(`演示排版 · ${++pageNumber} · 非真实市场数据`, margin, height - 45);
    const jpeg = await pdf.embedJpg(canvas.toDataURL('image/jpeg', .92));
    pdf.addPage([620, 877]).drawImage(jpeg, { x: 0, y: 0, width: 620, height: 877 });
  };
  begin();
  for (const raw of draft.markdown.split('\n')) {
    if (/^\|[\s:|\-]+\|$/.test(raw)) continue;
    const heading = raw.match(/^(#{1,6})\s/);
    const size = heading ? (heading[1].length === 1 ? 40 : 30) : 25;
    const lineHeight = size * 1.7;
    ctx.font = `${heading ? 'bold ' : ''}${size}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = heading ? '#234637' : '#26352f';
    const clean = raw.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/\*\*/g, '');
    let line = '';
    for (const char of clean) {
      if (ctx.measureText(line + char).width > width - 2 * margin) {
        if (y + lineHeight > height - 100) { await finish(); begin(); ctx.font = `${size}px "Microsoft YaHei", sans-serif`; ctx.fillStyle = '#26352f'; }
        ctx.fillText(line, margin, y); y += lineHeight; line = '';
      }
      line += char;
    }
    if (y + lineHeight > height - 100) { await finish(); begin(); ctx.font = `${size}px "Microsoft YaHei", sans-serif`; ctx.fillStyle = '#26352f'; }
    ctx.fillText(line, margin, y); y += clean ? lineHeight : 22;
  }
  await finish(); return pdf.save();
}
