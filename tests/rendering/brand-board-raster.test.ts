import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { brandBoardDirection } from "@/components/logo-creation/brand-board-direction";
import { drawBoardPreview, BOARD_PREVIEW_WIDTH, BOARD_PREVIEW_HEIGHT, type BoardPreviewSnapshot } from "@/components/logo-creation/brand-board-preview-export";

it("renders the social square and 3:1 X artwork directly into one real PNG canvas", async () => {
  expect(GlobalFonts.registerFromPath("node_modules/geist/dist/fonts/geist-sans/Geist-Variable.ttf", "Geist Sans")).toBeTruthy();
  const source = createCanvas(128, 128), ink = source.getContext("2d");
  ink.fillStyle = "#FFFFFF"; ink.fillRect(0, 0, 128, 128);
  ink.fillStyle = "#191919"; ink.fillRect(32, 32, 64, 64);
  const image = await loadImage(source.toBuffer("image/png"));
  const direction = brandBoardDirection([], "abstract");
  // The pure renderer consumes already verified image bytes. Receipt checks and
  // account revocation are separately exercised in preview/export client tests.
  const snapshot = { version: 1, name: "Synthetic Studio", logoNeedsReview: false, paletteSource: direction.paletteSource, palette: direction.palette, type: direction.type } as BoardPreviewSnapshot;
  const board = createCanvas(1, 1);
  drawBoardPreview(board as unknown as HTMLCanvasElement, image as unknown as HTMLImageElement, snapshot, '"Geist Sans"');
  expect([board.width, board.height]).toEqual([BOARD_PREVIEW_WIDTH, BOARD_PREVIEW_HEIGHT]);
  const pixel = (x: number, y: number) => [...board.getContext("2d").getImageData(x, y, 1, 1).data];
  expect(pixel(65, 1061)).toEqual([25, 25, 25, 255]);
  expect(pixel(623, 1619)).toEqual([25, 25, 25, 255]);
  expect(pixel(657, 1061)).toEqual([217, 214, 203, 255]);
  expect(pixel(1535, 1352)).toEqual([217, 214, 203, 255]);
  expect(pixel(1535, 1355)).toEqual([245, 243, 236, 255]);
  expect([...board.toBuffer("image/png").subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});
