/** Minimal grouped bar chart as a standalone SVG (no dependency), for the thesis figures. */
export function barChart(
  title: string,
  categories: string[],
  series: Array<{ name: string; values: number[] }>,
  opts: { max?: number; unit?: string } = {},
): string {
  const W = 760, H = 380, L = 60, R = 20, T = 50, B = 70;
  const colors = ['#94a3b8', '#f59e0b', '#2563eb'];
  const max = opts.max ?? Math.max(1e-9, ...series.flatMap((s) => s.values)) * 1.15;
  const plotW = W - L - R, plotH = H - T - B;
  const groupW = plotW / categories.length;
  const barW = (groupW * 0.75) / series.length;
  const y = (v: number) => T + plotH - (v / max) * plotH;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" font-size="12">\n`;
  svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>\n<text x="${W / 2}" y="24" text-anchor="middle" font-size="16" font-weight="bold">${title}</text>\n`;
  for (let i = 0; i <= 5; i++) {
    const v = (max * i) / 5;
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" fill="#475569">${max <= 1.0001 ? (v * 100).toFixed(0) + '%' : v.toFixed(1)}</text>\n`;
  }
  categories.forEach((c, ci) => {
    const gx = L + ci * groupW + groupW * 0.125;
    series.forEach((s, si) => {
      const v = s.values[ci] ?? 0;
      const x = gx + si * barW;
      svg += `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${(T + plotH - y(v)).toFixed(1)}" fill="${colors[si % colors.length]}"/>\n`;
      if (v > 0) svg += `<text x="${(x + barW / 2 - 1).toFixed(1)}" y="${(y(v) - 3).toFixed(1)}" text-anchor="middle" font-size="10" fill="#334155">${max <= 1.0001 ? (v * 100).toFixed(0) : v.toFixed(1)}</text>\n`;
    });
    svg += `<text x="${L + ci * groupW + groupW / 2}" y="${T + plotH + 18}" text-anchor="middle" fill="#334155">${c}</text>\n`;
  });
  svg += `<line x1="${L}" x2="${W - R}" y1="${T + plotH}" y2="${T + plotH}" stroke="#334155"/>\n`;
  series.forEach((s, si) => {
    const x = L + si * 220;
    svg += `<rect x="${x}" y="${H - 28}" width="14" height="14" fill="${colors[si % colors.length]}"/><text x="${x + 20}" y="${H - 16}" fill="#334155">${s.name}</text>\n`;
  });
  return svg + '</svg>\n';
}
