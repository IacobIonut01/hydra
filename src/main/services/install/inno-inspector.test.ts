import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_INNO_LANGUAGE,
  pickInnoSetupLanguage,
} from "./inno-inspector.js";

const makeInfo = (languages: { name: string; displayName?: string }[]) => ({
  version: "6.4.3.0",
  appName: "Game",
  languages: languages.map((language) => ({
    name: language.name,
    displayName: language.displayName ?? language.name,
  })),
  componentCount: 0,
  taskCount: 0,
  showLanguageDialog: "auto",
});

describe("pickInnoSetupLanguage", () => {
  it("falls back to english when inspection failed", () => {
    assert.equal(pickInnoSetupLanguage(null), FALLBACK_INNO_LANGUAGE);
  });

  it("falls back to english when the setup ships no languages", () => {
    assert.equal(pickInnoSetupLanguage(makeInfo([])), FALLBACK_INNO_LANGUAGE);
  });

  it("prefers the internal english name over other languages", () => {
    const info = makeInfo([
      { name: "russian", displayName: "Русский" },
      { name: "english", displayName: "English" },
    ]);
    assert.equal(pickInnoSetupLanguage(info), "english");
  });

  it("matches a localized English entry by display name", () => {
    const info = makeInfo([
      { name: "russian", displayName: "Русский" },
      { name: "en_gb", displayName: "English (UK)" },
    ]);
    assert.equal(pickInnoSetupLanguage(info), "en_gb");
  });

  it("takes the first declared language when English is absent", () => {
    const info = makeInfo([
      { name: "russian", displayName: "Русский" },
      { name: "polish", displayName: "Polski" },
    ]);
    assert.equal(pickInnoSetupLanguage(info), "russian");
  });
});
