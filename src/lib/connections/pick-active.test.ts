import { describe, expect, it } from "vitest";
import { pickActiveConnectionId } from "./pick-active";

const LIST = [
  { id: "a", is_primary: false },
  { id: "b", is_primary: true },
  { id: "c", is_primary: false },
];

describe("pickActiveConnectionId — ordem de preferência", () => {
  it("cookie válido (na lista) vence", () => {
    expect(pickActiveConnectionId(LIST, "c", "a")).toBe("c");
  });

  it("cookie fora da lista → cai no prev (válido)", () => {
    expect(pickActiveConnectionId(LIST, "zzz", "a")).toBe("a");
  });

  it("cookie e prev fora → primária", () => {
    expect(pickActiveConnectionId(LIST, null, "zzz")).toBe("b");
  });

  it("sem primária → 1ª da lista", () => {
    const noPrimary = [
      { id: "x", is_primary: false },
      { id: "y", is_primary: false },
    ];
    expect(pickActiveConnectionId(noPrimary, null, null)).toBe("x");
  });

  it("lista vazia → null", () => {
    expect(pickActiveConnectionId([], "a", "b")).toBeNull();
  });
});
