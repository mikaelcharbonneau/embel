/* eslint-disable @next/next/no-img-element -- Synthetic local PNGs exercise the actual unoptimized private-preview layout. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { brandBoardFont } from "@/domain/brand-board-fonts";
import { VisualDirectionsView, type VisualDirectionCard } from "@/components/visual-directions/visual-directions-view";
import "../../src/styles/globals.css";
import "../../src/styles/identity.css";
import "./visual-directions-preview.css";

// Synthetic presentation data only. No customer records, provider calls or saved app state.
const designs = [
  { title: "Natural confidence", ink: "#194D39", paper: "#EEEDE2", accent: "#D1ED98", font: "Lora", summary: "Rich greens, an expressive serif and generous space create a grounded, welcoming presence." },
  { title: "Quiet precision", ink: "#254BD0", paper: "#EBF0FC", accent: "#A6BDF5", font: "Manrope", summary: "Clear blue, crisp typography and a structured layout bring focus and a sense of forward motion." },
  { title: "Warm momentum", ink: "#9B3730", paper: "#F6E6DC", accent: "#EBAC8D", font: "Lora", summary: "Warm neutrals and confident contrasts give the brand an approachable, editorial character." },
];
function logo(context: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  context.strokeStyle = color; context.lineWidth = size * .14; context.lineJoin = "miter";
  context.beginPath(); context.moveTo(x, y + size); context.lineTo(x, y); context.lineTo(x + size * .75, y + size); context.lineTo(x + size * .75, y); context.stroke();
}
function board(index: number) {
  const d = designs[index]!, canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
  const c = canvas.getContext("2d")!;
  c.fillStyle = d.paper; c.fillRect(0, 0, 1024, 1024); c.fillStyle = d.ink;
  c.font = "24px Arial"; c.fillText("NORTHLINE  /  VISUAL DIRECTION", 48, 62);
  c.font = `52px ${d.font}`; c.fillText(d.title, 48, 140);
  c.fillStyle = d.ink; c.fillRect(48, 190, 550, 384); logo(c, 242, 278, 190, d.paper);
  c.fillStyle = d.ink; c.font = "20px Arial"; c.fillText("COLOR PALETTE", 636, 218);
  [d.ink, d.accent, d.paper, "#FFFFFF"].forEach((color, i) => { c.fillStyle = color; c.fillRect(636 + i % 2 * 166, 244 + Math.floor(i / 2) * 150, 148, 130); });
  c.fillStyle = d.ink; c.font = "20px Arial"; c.fillText("TYPOGRAPHY", 48, 630);
  c.font = `54px ${d.font}`; c.fillText("Built for what’s next.", 48, 705);
  c.font = "21px Arial"; c.fillText("Simple ideas. A confident point of view.", 48, 748);
  c.fillStyle = "#FFFFFF"; c.fillRect(48, 798, 430, 178); logo(c, 75, 824, 34, d.ink);
  c.fillStyle = d.ink; c.font = `30px ${d.font}`; c.fillText("A fresh perspective.", 75, 917); c.font = "14px Arial"; c.fillText("northline.example", 75, 950);
  c.fillStyle = d.accent; c.fillRect(498, 798, 210, 178); logo(c, 563, 842, 86, d.ink);
  c.fillStyle = d.ink; c.fillRect(728, 798, 248, 178); c.fillStyle = d.paper; c.font = "14px Arial"; c.fillText("NORTHLINE", 750, 832); c.font = `27px ${d.font}`; c.fillText("Made to move", 750, 905); c.fillText("you forward.", 750, 937);
  return canvas.toDataURL("image/png");
}
async function drawBoards() {
  await Promise.all([...new Set(designs.map(design => design.font))].map(async family => {
    const font = brandBoardFont(family)!;
    const face = new FontFace(family, `url("${font.file}")`, { weight: `${font.minWeight} ${font.maxWeight}` });
    document.fonts.add(await face.load());
  }));
  return designs.map((_design, index) => board(index));
}
const logoCanvas = document.createElement("canvas"); logoCanvas.width = logoCanvas.height = 140; logo(logoCanvas.getContext("2d")!, 35, 22, 95, "#191919");
const logoImage = logoCanvas.toDataURL("image/png");
function Preview({ boards }: { boards: string[] }) {
  const mode = new URLSearchParams(location.search).get("state") ?? "complete";
  const [selected, setSelected] = useState<string | null>(mode === "complete" ? "1" : null);
  const [message, setMessage] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const amount = mode === "empty" ? 0 : mode === "partial" ? 2 : 3;
  const cards = designs.map((d, index): VisualDirectionCard | null => index >= amount ? null : ({
    id: String(index), title: mode === "long" && index === 0 ? "A deliberately longer name for this saved visual direction" : d.title,
    summary: d.summary, selected: selected === String(index),
    swatches: [{ name: "Ink", hex: d.ink }, { name: "Paper", hex: d.paper }, { name: "Accent", hex: d.accent }],
    sampleStyle: { family: d.font, weight: 600, style: "normal" },
    preview: <figure className="identity-board"><div className="identity-board-image"><img src={boards[index]} alt={`Synthetic board ${index + 1}`} /></div></figure>,
    onChoose: () => { setSelected(String(index)); setMessage("Direction saved."); },
  })) as [VisualDirectionCard | null, VisualDirectionCard | null, VisualDirectionCard | null];
  return <div className="fixtureShell"><aside className="fixtureSidebar"><strong>Embel</strong><span>WORKSPACE</span><a href="#fixture">Projects</a><a href="#fixture">Assets</a></aside>
    <main className="fixtureMain"><div className="fixtureTopbar"><span>Projects <b>/</b> Northline</span><small>Synthetic UI fixture</small></div>
      <VisualDirectionsView brandName={mode === "long" ? "Northline — a longer project name to verify narrow screens" : "Northline"}
        logoPreview={<img src={logoImage} alt="Synthetic chosen logo" />} backHref="#fixture" cards={cards}
        generation={{ status: started ? "queued" : mode === "empty" ? "idle" : mode === "partial" ? "partial" : "complete", completed: amount,
          usageLabel: amount ? "Recorded usage for this set: $0.04" : null,
          onGenerate: () => setStarted(true), onCheck: () => setMessage("Progress checked."), onStop: () => setStarted(false) }}
        selectionStatus={message} finalAction={selected !== null && <a className="identity-primary-button" href="#brand-assets">View brand assets</a>} />
    </main></div>;
}
void drawBoards().then(boards => createRoot(document.getElementById("root")!).render(<Preview boards={boards} />));
