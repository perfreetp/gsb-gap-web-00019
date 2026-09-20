// 生成签到用二维码（极简二维码通过第三方库 qrcode 也可；此处使用二维码占位图案+可读载荷，
// 真正部署可替换为 qrcode.toDataURL）
export function uuid() {
  return 'evt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

// 轻量伪二维码：用确定性的棋盘格图案承载视觉提示，弹窗同时展示可复制载荷（演示用）
export function pseudoQR(text, size = 160) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#1f2a24';
  const cells = 21, c = size / cells;
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    // 三角定位符
    const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
    if (finder) {
      const fx = x < 7 ? x : x - 14, fy = y < 7 ? y : y - 14;
      const edge = fx === 0 || fx === 6 || fy === 0 || fy === 6;
      const core = fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4;
      if (edge || core) ctx.fillRect(x * c, y * c, c, c);
    } else if (rand() > 0.52) ctx.fillRect(x * c, y * c, c, c);
  }
  return canvas.toDataURL();
}
