import { useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LOCALE_STORAGE_KEY,
  LOCALES,
  currentLocale,
  type Locale,
} from "@/lib/i18n/locale";
import { t } from "@/lib/i18n/t";

/**
 * The interface language.
 *
 * Unlike the theme next to it, this one cannot be applied in place: every `t()` call reads the
 * language once when its module loads, so the new language arrives with a fresh module graph.
 * Recording the choice and reloading is the whole mechanism — and it is why this row says so.
 */
export function LanguagePreference() {
  const [locale, setLocale] = useState<Locale>(() => currentLocale());

  function choose(next: Locale) {
    if (next === locale) {
      return;
    }
    try {
      globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the reload would drop the choice anyway, so there is nothing to report
      // beyond the fact that the select keeps showing the language still in use.
      return;
    }
    setLocale(next);
    globalThis.location?.reload();
  }

  return (
    <PageRows>
      <Item size="sm">
        <ItemContent>
          <ItemTitle>{t("Language")}</ItemTitle>
          <ItemDescription>
            {t("CCP-Bot reloads once when you switch languages.")}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={locale}
            onValueChange={(value) => {
              if (value === "zh-CN" || value === "en") {
                choose(value);
              }
            }}
          >
            <SelectTrigger aria-label={t("Language")}>
              <SelectValue>
                {t(
                  (
                    LOCALES.find((entry) => entry.value === locale) ??
                    LOCALES[0]
                  ).label,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {t(entry.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
    </PageRows>
  );
}
