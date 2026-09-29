import type { InnoSetupInfo } from "@main/services/native-addon";

// Multi-language Inno setups paint a "Select Setup Language" dialog even
// under /VERYSILENT, and /LANG is the only flag that suppresses it -- but
// the flag must name a language the [Languages] section actually ships.
// English is present in every FitGirl-family repack, so it stays the
// fallback when inspection finds nothing.
export const FALLBACK_INNO_LANGUAGE = "english";

/**
 * Chooses the /LANG value for a silent run. Prefers English (present in
 * virtually every repack family); otherwise takes the repack's first
 * declared language, and finally the bare fallback when the setup could
 * not be inspected at all. A rejected name still gets the caller's
 * retry-without-/LANG path.
 */
export const pickInnoSetupLanguage = (info: InnoSetupInfo | null): string => {
  const languages = info?.languages ?? [];
  const english = languages.find(
    (language) =>
      language.name.toLowerCase() === FALLBACK_INNO_LANGUAGE ||
      language.displayName.toLowerCase().startsWith(FALLBACK_INNO_LANGUAGE)
  );
  return english?.name ?? languages[0]?.name ?? FALLBACK_INNO_LANGUAGE;
};
