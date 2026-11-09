/** Persisted interface locale, deliberately independent of screen history and source content. */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createLocaleTools } from './locales';
import type { Locale, LocaleTools } from './locales';

/** Locale formatting plus the explicit local-only preference action. */
interface LocaleContextValue extends LocaleTools {
  /** Updates interface language without changing filters, navigation or external services. */
  setLocale: (locale: Locale) => void;
}
/** Missing provider is a programming error rather than an implicit language fallback. */
const LocaleContext = createContext<LocaleContextValue | null>(null);
/** Validates the local storage preference; absent, malformed or unavailable storage defaults to Russian. */
function initialLocale(): Locale {
  try { return localStorage.getItem('agent-hub-locale') === 'en' ? 'en' : 'ru'; }
  catch { return 'ru'; }
}
/** Owns locale lifetime and synchronizes document language/title and browser preference only. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  /** Locale does not enter the screen snapshot, so switching cannot change Back history. */
  const [locale, setLocale] = useState<Locale>(initialLocale);
  /** Stable native formatters are recreated only after a deliberate language switch. */
  const tools = useMemo(() => createLocaleTools(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = tools.t('Agent Hub — ecosystem overview');
    try { localStorage.setItem('agent-hub-locale', locale); } catch { /* In-memory switching remains available without storage. */ }
  }, [locale, tools]);
  return <LocaleContext.Provider value={{ ...tools, setLocale }}>{children}</LocaleContext.Provider>;
}
/** Reads the active interface locale; throws when a first-party component lacks its required provider. */
export function useLocale(): LocaleContextValue {
  /** The provider is required so no component silently diverges from the selected locale. */
  const context = useContext(LocaleContext);
  if (!context) throw new Error('LocaleProvider is required');
  return context;
}
