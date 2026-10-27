import { test } from "node:test";
import assert from "node:assert/strict";
import { speechText } from "../src/lib/voice.ts";

test("speechText reads the prose of a markdown reply, not its markup", () => {
  const md = [
    "## Resultado",
    "",
    "El disco está al **82%**. Mirá [el panel](https://example.com/disk) o https://x.dev.",
    "",
    "```bash",
    "df -h",
    "```",
    "",
    "- Usá `ncdu /var` para ver qué ocupa",
    "1. Borrá los logs viejos",
    "",
    "| Disco | Uso |",
    "|---|---|",
    "> Ojo con /tmp",
  ].join("\n");
  assert.equal(
    speechText(md),
    "Resultado El disco está al 82%. Mirá el panel o Usá ncdu /var para ver qué ocupa Borrá los logs viejos Disco Uso Ojo con /tmp",
  );
  assert.equal(speechText("```\nsolo código\n```"), "");
});
