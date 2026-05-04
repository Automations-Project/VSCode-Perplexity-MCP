import { describe, expect, it } from "vitest";
import { GenericIdeIcon, getIdeIcon } from "../src/ide-icons";

describe("IDE brand icons", () => {
  it("uses the supplied OpenCode logo instead of the generic fallback", () => {
    expect(getIdeIcon("openCode")).not.toBe(GenericIdeIcon);
  });
});
