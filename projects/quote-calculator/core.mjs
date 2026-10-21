export function quote({
  pages = 1,
  form = false,
  map = false,
  maintenance = false,
  urgent = false,
} = {}) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 20)
    throw new RangeError("Choose between 1 and 20 pages.");
  const items = [["First page", 120]];
  if (pages > 1)
    items.push([pages - 1 + " additional page(s)", (pages - 1) * 40]);
  if (form) items.push(["Contact form", 35]);
  if (map) items.push(["Interactive map", 75]);
  if (maintenance) items.push(["One maintenance session", 30]);
  const subtotal = items.reduce((sum, item) => sum + item[1], 0);
  if (urgent)
    items.push(["Priority delivery (25%)", Math.round(subtotal * 0.25)]);
  return { items, total: items.reduce((sum, item) => sum + item[1], 0) };
}
