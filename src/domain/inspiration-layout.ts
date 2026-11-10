/** Layout for the Inspiration bento: every image keeps its own shape (nothing
 * is cropped), each brand arranges its images in rows, and brands share rows
 * of equal height whose widths follow their content. Pure; sizes in CSS px. */
export const BENTO = {
  /** Space between images inside a brand, and between brands. */
  tileGap: 6,
  cardGap: 12,
  /** Card border + padding (x), plus the 36px header and its 8px margin (y). */
  chromeX: 18,
  chromeY: 62,
  /** Preferred combined aspect ratio of one row of images inside a brand. */
  rowRatio: 2.4,
  /** Preferred card shape (width / height) and how strongly it is preferred. */
  cardRatio: 0.85,
  cardWeight: 0.6,
  /** Narrowest card and most cards in one row. */
  minCardWidth: 230,
  maxPerRow: 3,
} as const;

type Sized = { width: number; height: number };
const ratio = (image: Sized) => image.width / image.height;
const rowSum = (row: readonly Sized[]) => row.reduce((total, image) => total + ratio(image), 0);

/** A brand's height for a card width w: height = slope * w + offset. */
export type CardShape = { slope: number; offset: number };
export function cardShape(rows: readonly (readonly Sized[])[]): CardShape {
  const sums = rows.map(rowSum);
  // Each row is (content width - gaps between its images) / its combined ratio tall.
  const slope = sums.reduce((total, sum) => total + 1 / sum, 0);
  const gaps =
    BENTO.tileGap * (rows.length - 1) -
    BENTO.tileGap * rows.reduce((total, row, index) => total + (row.length - 1) / sums[index]!, 0);
  return { slope, offset: gaps + BENTO.chromeY - slope * BENTO.chromeX };
}

/** Splits a brand's images, kept in order, into rows close to the preferred row
 * ratio, nudged toward a moderate card shape so neighbors stay comparable. */
export function brandRows<T extends Sized>(images: readonly T[]): T[][] {
  if (images.length < 2) return [images.slice()];
  let best: T[][] = [images.slice()],
    bestCost = Number.POSITIVE_INFINITY;
  for (let breaks = 0; breaks < 1 << (images.length - 1); breaks++) {
    const rows: T[][] = [[images[0]!]];
    images.slice(1).forEach((image, index) => {
      if (breaks & (1 << index)) rows.push([image]);
      else rows.at(-1)!.push(image);
    });
    const shape = 1 / rows.reduce((total, row) => total + 1 / rowSum(row), 0);
    const cost =
      rows.reduce((total, row) => total + Math.log(rowSum(row) / BENTO.rowRatio) ** 2, 0) +
      BENTO.cardWeight * Math.log(shape / BENTO.cardRatio) ** 2;
    if (cost < bestCost - 1e-9) {
      best = rows;
      bestCost = cost;
    }
  }
  return best;
}

export type BentoBox = { x: number; y: number; width: number; height: number };
/** Places cards, in order, in full-width rows of equal height. Row breaks are
 * chosen so row heights stay near the target; each card's width then follows
 * from its shape. Returns one box per card and the total height. */
export function bentoLayout(
  shapes: readonly CardShape[],
  width: number,
  target = bentoTarget(width),
): { boxes: BentoBox[]; height: number } {
  const gap = BENTO.cardGap,
    count = shapes.length;
  const height = (start: number, end: number) => {
    let inverse = 0,
      offsets = 0;
    for (let index = start; index < end; index++) {
      inverse += 1 / shapes[index]!.slope;
      offsets += shapes[index]!.offset / shapes[index]!.slope;
    }
    return (width - gap * (end - start - 1) + offsets) / inverse;
  };
  const widthAt = (shape: CardShape, rowHeight: number) => (rowHeight - shape.offset) / shape.slope;
  const cost = Array<number>(count + 1).fill(Number.POSITIVE_INFINITY),
    from = Array<number>(count + 1).fill(0);
  cost[0] = 0;
  for (let end = 1; end <= count; end++) {
    for (let start = Math.max(0, end - BENTO.maxPerRow); start < end; start++) {
      const rowHeight = height(start, end);
      const fits =
        rowHeight > 0 &&
        (end - start === 1 ||
          shapes.slice(start, end).every((shape) => widthAt(shape, rowHeight) >= BENTO.minCardWidth));
      if (!fits) continue;
      const total = cost[start]! + Math.log(rowHeight / target) ** 2;
      if (total < cost[end]!) {
        cost[end] = total;
        from[end] = start;
      }
    }
  }
  const rows: [number, number][] = [];
  for (let end = count; end > 0; end = from[end]!) rows.unshift([from[end]!, end]);
  const boxes: BentoBox[] = [];
  let y = 0;
  for (const [start, end] of rows) {
    const rowHeight = Math.round(height(start, end));
    let x = 0;
    for (let index = start; index < end; index++) {
      // Whole pixels; the last card takes the remainder so the row is exactly full.
      const cardWidth = index === end - 1 ? width - x : Math.round(widthAt(shapes[index]!, rowHeight));
      boxes.push({ x, y, width: cardWidth, height: rowHeight });
      x += cardWidth + gap;
    }
    y += rowHeight + gap;
  }
  return { boxes, height: Math.max(0, y - gap) };
}
/** Preferred row height for a gallery width. */
export const bentoTarget = (width: number) => Math.min(520, Math.max(320, width * 0.62));
