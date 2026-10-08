import { describe, expect, it } from "vitest";
import { strategyPartialMessage } from "@/components/workspace/strategy-partial-message";

describe("streamed strategy message display", () => {
  it("displays the actual message before the surrounding proposal is complete", () => {
    expect(strategyPartialMessage('{"message":"A neighborhood kitchen')).toBe("A neighborhood kitchen");
    expect(strategyPartialMessage('{"message":"A neighborhood kitchen","activity":')).toBe("A neighborhood kitchen");
    expect(strategyPartialMessage('{"activity":"Kitchen","message":"A welcoming lunch')).toBe("A welcoming lunch");
  });
  it("decodes complete escapes without inventing incomplete characters", () => {
    const prefix = '{"message":"Hello\\n\\"neighbors\\"\\t';
    expect(strategyPartialMessage(prefix)).toBe('Hello\n"neighbors"\t');
    for (const suffix of ["\\", "\\u", "\\u2", "\\u26", "\\u263"]) expect(strategyPartialMessage(prefix + suffix)).toBe('Hello\n"neighbors"\t');
    expect(strategyPartialMessage(prefix + '\\u263A\\/\\\\')).toBe('Hello\n"neighbors"\t☺/\\');
    expect(strategyPartialMessage('{"mess\\u0061ge":"Visible text')).toBe("Visible text");
  });
  it("waits for both halves of a surrogate pair", () => {
    for (const suffix of ["\\uD83D", "\\uD83D\\", "\\uD83D\\u", "\\uD83D\\uDE8", "\uD83D"]) {
      expect(strategyPartialMessage('{"message":"Hello ' + suffix)).toBe("Hello ");
    }
    expect(strategyPartialMessage('{"message":"Hello \\uD83D\\uDE80')).toBe("Hello 🚀");
    expect(strategyPartialMessage('{"message":"Hello 🚀')).toBe("Hello 🚀");
    for (const suffix of ["\\uDE80", "\\uD83Dx", '\\uD83D"}', "\uDE80"]) expect(strategyPartialMessage('{"message":"Hello ' + suffix)).toBeNull();
  });
  it.each([
    "A raw response is not a structured proposal", "[]", '{"message":123}', '{"message":null}',
    '{"message":"bad\\q', '{"message":"bad\\u00xz', '{"message":"bad\nnewline',
    '{"message":"first","message":"second"}', '{"message":"Hello" nonsense',
    '{"message":"Hello"} trailing', '{"other":truX,"message":"Do not show"}',
    '{"reasoning":{"message":"Private reasoning"}}', '{"message":', '{"message":"',
  ])("does not expose malformed, ambiguous or unrelated output: %s", input => {
    expect(strategyPartialMessage(input)).toBeNull();
  });
  it("ignores nested and quoted message keys while extracting only the root message", () => {
    const input = { reasoning: { message: "Private reasoning" }, notes: 'A quoted "message":"not the response"', values: [true, false, null, -1.5e2, { nested: [1, 2] }], message: "Visible response" };
    expect(strategyPartialMessage(JSON.stringify(input))).toBe("Visible response");
    expect(strategyPartialMessage(JSON.stringify(input).slice(0, -3))).toBe("Visible respons");
  });
  it("preserves text exactly for React to escape, without interpreting markup", () => {
    const text = '<img src=x onerror="alert(1)"> & <script>not HTML</script>';
    expect(strategyPartialMessage(JSON.stringify({ message: text }))).toBe(text);
  });
  it("bounds scanning, nesting and displayed output without splitting Unicode", () => {
    expect(strategyPartialMessage('{"message":"' + "a".repeat(7000))).toBe("a".repeat(6000));
    expect(strategyPartialMessage('{"message":"' + "a".repeat(5999) + "🚀z")).toBe("a".repeat(5999));
    expect(strategyPartialMessage('{"nested":' + "[".repeat(40) + '"message"')).toBeNull();
    expect(strategyPartialMessage('{"padding":"' + "x".repeat(140_000) + '","message":"Out of scan bounds"}')).toBeNull();
  });
});
