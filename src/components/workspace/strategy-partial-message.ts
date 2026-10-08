const MAX_SCAN_LENGTH = 131_072;
const MAX_MESSAGE_LENGTH = 6000;
const MAX_DEPTH = 24;
type ParseStatus = "complete" | "incomplete" | "invalid";
const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Display-only JSON-prefix reader. It never makes a partial proposal applicable. */
export function strategyPartialMessage(partial: string): string | null {
  const text = partial.slice(0, MAX_SCAN_LENGTH);
  let at = 0;
  let message: string | null = null;
  let sawMessage = false;
  const whitespace = () => { while (at < text.length && /[\t\n\r ]/.test(text[at]!)) at += 1; };

  function string(capture: boolean): { status: ParseStatus; value: string } {
    at += 1; // The caller verified the opening quote.
    let value = "";
    let highSurrogate = "";
    let truncated = false;
    while (at < text.length) {
      let character = text[at++]!;
      if (character === '"') return { status: highSurrogate ? "invalid" : "complete", value };
      if (character.charCodeAt(0) < 32) return { status: "invalid", value: "" };
      if (character === "\\") {
        if (at === text.length) return { status: "incomplete", value };
        const escape = text[at++]!;
        if (escape === "u") {
          const hex = text.slice(at, at + 4);
          if (/[^\da-f]/i.test(hex)) return { status: "invalid", value: "" };
          if (hex.length < 4) return { status: "incomplete", value };
          character = String.fromCharCode(Number.parseInt(hex, 16)); at += 4;
        } else {
          if (!Object.hasOwn(escapes, escape)) return { status: "invalid", value: "" };
          character = escapes[escape]!;
        }
      }
      const code = character.charCodeAt(0);
      if (highSurrogate) {
        if (code < 0xdc00 || code > 0xdfff) return { status: "invalid", value: "" };
        character = highSurrogate + character; highSurrogate = "";
      } else if (code >= 0xd800 && code <= 0xdbff) { highSurrogate = character; continue; }
      else if (code >= 0xdc00 && code <= 0xdfff) return { status: "invalid", value: "" };
      if (capture && !truncated) {
        if (value.length + character.length > MAX_MESSAGE_LENGTH) truncated = true;
        else value += character;
      }
    }
    // A trailing escape or high surrogate is withheld until its full character arrives.
    return { status: "incomplete", value };
  }

  function value(depth: number, captureMessage = false): ParseStatus {
    if (depth > MAX_DEPTH) return "invalid";
    whitespace();
    if (at === text.length) return "incomplete";
    if (text[at] === '"') {
      const result = string(captureMessage);
      if (captureMessage && result.status !== "invalid" && result.value.trim()) message = result.value;
      return result.status;
    }
    if (captureMessage) return "invalid";
    if (text[at] === "{") return object(depth);
    if (text[at] === "[") {
      at += 1; whitespace();
      if (text[at] === "]") { at += 1; return "complete"; }
      while (at < text.length) {
        const status = value(depth + 1);
        if (status !== "complete") return status;
        whitespace();
        if (at === text.length) return "incomplete";
        if (text[at] === "]") { at += 1; return "complete"; }
        if (text[at++] !== ",") return "invalid";
        whitespace();
      }
      return "incomplete";
    }
    const start = at;
    while (at < text.length && !/[\t\n\r ,\]}]/.test(text[at]!)) at += 1;
    const token = text.slice(start, at);
    if (["true", "false", "null"].includes(token) || /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return "complete";
    if (at === text.length && (["true", "false", "null"].some(literal => literal.startsWith(token))
      || /^-$/.test(token) || /^-?(?:0|[1-9]\d*)\.$/.test(token) || /^-?(?:0|[1-9]\d*)(?:\.\d+)?[eE][+-]?$/.test(token))) return "incomplete";
    return "invalid";
  }

  function object(depth: number): ParseStatus {
    at += 1; whitespace();
    if (text[at] === "}") { at += 1; return "complete"; }
    while (at < text.length) {
      if (text[at] !== '"') return "invalid";
      const key = string(true);
      if (key.status !== "complete") return key.status;
      whitespace();
      if (at === text.length) return "incomplete";
      if (text[at++] !== ":") return "invalid";
      const captureMessage = depth === 0 && key.value === "message";
      if (captureMessage && sawMessage) return "invalid";
      if (captureMessage) sawMessage = true;
      const status = value(depth + 1, captureMessage);
      if (status !== "complete") return status;
      whitespace();
      if (at === text.length) return "incomplete";
      if (text[at] === "}") { at += 1; return "complete"; }
      if (text[at++] !== ",") return "invalid";
      whitespace();
    }
    return "incomplete";
  }

  whitespace();
  if (text[at] !== "{") return null;
  const status = object(0);
  whitespace();
  return status === "invalid" || (status === "complete" && at !== text.length) ? null : message;
}
