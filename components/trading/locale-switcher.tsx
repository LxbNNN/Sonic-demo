/**
 * 语言切换器
 * 点击在 en / zh 之间切换，通过 cookie + router.refresh() 实现无刷新切换
 */

"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";
import { Globe } from "lucide-react";

export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations("locale");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const toggleLocale = useCallback(() => {
    const next = locale === "en" ? "zh" : "en";
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=31536000`;
    startTransition(() => {
      router.refresh();
    });
  }, [locale, router]);

  return (
    <button
      onClick={toggleLocale}
      disabled={isPending}
      className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-accent transition-colors"
    >
      <Globe className="h-3.5 w-3.5" />
      <span>{t(locale === "en" ? "zh" : "en")}</span>
    </button>
  );
}
