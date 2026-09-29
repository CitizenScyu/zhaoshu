import type { CheerioAPI } from 'cheerio';

/**
 * 仅识别有真实挑战表单和页面级提示的 Cloudflare 拦截页。
 * 复用求值 DOM，不把正文关键词、转义 HTML 或单独加载的脚本当作拦截。
 * 不按正文长度判定：短尾声有效，长提示也可能是挑战页。
 */
export function isStructuredChallengePage($: CheerioAPI): boolean {
  const hasChallengeForm = $('form#challenge-form[action]').toArray().some((form) => {
    try {
      const action = new URL($(form).attr('action')!, 'https://challenge.invalid');
      return /^\/cdn-cgi\/challenge-platform\//.test(action.pathname);
    } catch { return false; }
  });
  if (!hasChallengeForm) return false;
  // 页面标题/主标题的完整提示才算语义信号，人物台词中的子串不算。
  return $('title, h1').toArray().some((heading) => {
    const text = $(heading).text().replace(/\s+/g, ' ').trim();
    return /^(?:just a moment|checking your browser|verify you are human|请完成安全验证)[.!…。！\s]*$/i.test(text);
  });
}
