import { describe, expect, it } from "vitest";
import { inspirationBrands } from "@/domain/inspiration";
import {
  BENTO,
  bentoLayout,
  bentoMaxPerRow,
  brandRows,
  cardShape,
  MASONRY,
  masonryColumns,
  masonryPlace,
} from "@/domain/inspiration-layout";

const image = (width: number, height: number, part = `${width}x${height}`) => ({ part, width, height });
// The rendered height of a card at a width: rows of equal-height images plus chrome.
function renderedHeight(rows: { width: number; height: number }[][], cardWidth: number) {
  const content = cardWidth - BENTO.chromeX;
  const rowHeights = rows.map(
    (row) =>
      (content - BENTO.tileGap * (row.length - 1)) / row.reduce((total, item) => total + item.width / item.height, 0),
  );
  return rowHeights.reduce((total, height) => total + height, 0) + BENTO.tileGap * (rows.length - 1) + BENTO.chromeY;
}

describe("images inside a brand", () => {
  it("keeps every image, in order, in rows that depend on the images' shapes", () => {
    for (const brand of inspirationBrands) {
      const rows = brandRows(brand.parts);
      expect(rows.flat()).toEqual(brand.parts);
      expect(rows.every((row) => row.length > 0)).toBe(true);
    }
    // Wide images get rows of their own; small square ones share rows.
    expect(
      brandRows([image(3000, 1000), image(3000, 1000), image(1000, 1000), image(1000, 1000), image(1000, 1000)]).map(
        (row) => row.length,
      ),
    ).toEqual([1, 1, 3]);
    expect(
      new Set(
        inspirationBrands.map((brand) =>
          brandRows(brand.parts)
            .map((row) => row.length)
            .join(""),
        ),
      ).size,
    ).toBeGreaterThan(2);
  });

  it("predicts a card's height exactly from its width", () => {
    for (const brand of inspirationBrands.slice(0, 10)) {
      const rows = brandRows(brand.parts),
        shape = cardShape(rows);
      for (const width of [240, 367, 520])
        expect(shape.slope * width + shape.offset).toBeCloseTo(renderedHeight(rows, width), 6);
    }
  });
});

describe("brands in the bento", () => {
  const shapes = inspirationBrands.map((brand) => cardShape(brandRows(brand.parts)));
  it("fills each row edge to edge with cards of equal height, as wide as their content needs", () => {
    for (const width of [747, 1350, 2600]) {
      const { boxes, height } = bentoLayout(shapes, width);
      expect(boxes).toHaveLength(shapes.length);
      const rows = new Map<number, { box: (typeof boxes)[number]; shape: (typeof shapes)[number] }[]>();
      boxes.forEach((box, index) => rows.set(box.y, [...(rows.get(box.y) ?? []), { box, shape: shapes[index]! }]));
      for (const row of rows.values()) {
        expect(new Set(row.map((item) => item.box.height)).size).toBe(1);
        expect(row.reduce((total, item) => total + item.box.width, 0) + BENTO.cardGap * (row.length - 1)).toBe(width);
        expect(row.length).toBeLessThanOrEqual(bentoMaxPerRow(width));
        if (row.length > 1)
          for (const item of row) expect(item.box.width).toBeGreaterThanOrEqual(BENTO.minCardWidth - 1);
        // Each card's width matches its content at the row height, to the pixel.
        for (const item of row.slice(0, -1))
          expect(Math.abs(item.shape.slope * item.box.width + item.shape.offset - item.box.height)).toBeLessThan(2);
      }
      expect(Math.max(...boxes.map((box) => box.y + box.height))).toBe(height);
      // Several brands share most rows instead of a one-column list.
      expect(rows.size).toBeLessThan(shapes.length / 1.6);
    }
  });

  it("gives a single brand the full width and handles an empty list", () => {
    expect(bentoLayout([], 747)).toEqual({ boxes: [], height: 0 });
    expect(bentoLayout(shapes.slice(0, 1), 747).boxes[0]).toMatchObject({ x: 0, y: 0, width: 747 });
  });
});

describe("single images in the masonry", () => {
  it("fits as many columns of at least the minimum width as the gallery holds, two on a phone", () => {
    expect(masonryColumns(1056).count).toBe(4);
    expect(masonryColumns(2200).count).toBe(9);
    expect(masonryColumns(358).count).toBe(2);
    expect(masonryColumns(280).count).toBe(1);
    for (const width of [358, 700, 1056, 1700, 2600]) {
      const columns = masonryColumns(width);
      expect(columns.width * columns.count + MASONRY.columnGap * (columns.count - 1)).toBeCloseTo(width, 6);
      if (columns.count > 2) expect(columns.width).toBeGreaterThanOrEqual(MASONRY.minColumn);
    }
  });

  it("puts each card at the top of the shortest column, so the columns end close together", () => {
    const columns = { count: 3, width: 100 };
    const { boxes, height } = masonryPlace([300, 100, 100, 50, 80], columns);
    const step = 100 + MASONRY.columnGap,
      gap = MASONRY.rowGap;
    expect(boxes).toEqual([
      { x: 0, y: 0 },
      { x: step, y: 0 },
      { x: 2 * step, y: 0 },
      { x: step, y: 100 + gap },
      { x: 2 * step, y: 100 + gap },
    ]);
    expect(height).toBe(300);
    // Many cards of mixed heights: no column ends more than one card's height below another.
    const heights = Array.from({ length: 200 }, (_, index) => 120 + ((index * 73) % 260));
    const placed = masonryPlace(heights, { count: 5, width: 200 });
    const ends = Array<number>(5).fill(0);
    placed.boxes.forEach((box, index) => {
      const column = Math.round(box.x / (200 + MASONRY.columnGap));
      ends[column] = Math.max(ends[column]!, box.y + heights[index]!);
    });
    expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(Math.max(...heights) + MASONRY.rowGap);
    expect(masonryPlace([], columns)).toEqual({ boxes: [], height: 0 });
  });
});
