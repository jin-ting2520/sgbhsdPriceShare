'use strict';

/** 管理后台配置的 Markdown 帮助内容：渲染并过滤危险 HTML。 */

const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const MAX_MARKDOWN = 20000;

const DEFAULT_KEY_HELP_MD = `**还没有卡密？**
管理员启用卡密前，可以直接注册试用；启用后必须填写有效卡密才能注册。
已有账号试用结束或卡密到期后，也可以在登录页输入新卡密继续使用。`;

const DEFAULT_TOKEN_HELP_MD = `1. 在电脑浏览器打开游戏网页端，登录要同步价格的账号。
2. 按 **F12**（或右键 → 检查）打开开发者工具，切换到 **Application / 应用**。
3. 左侧选择 **Storage → Local Storage**，点击游戏页面对应的域名。
4. 在右侧列表找到键名 \`x-game-token-pcweb\`，复制它的 **Value**。
5. 回到本系统，把完整 Value 粘贴到「从游戏同步价格」或「定时自动同步」的登录 token 输入框。

> token 一般可用约 12 天，失效后重新登录并按上述步骤复制。token 等同于游戏账号登录凭证，请勿发给他人或提交到仓库。`;

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = sanitizeHtml.defaults.allowedTags.concat([
  'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'del', 'details', 'summary',
]);

const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
  code: ['class'],
  th: ['align'],
  td: ['align'],
};

function renderMarkdown(source) {
  const raw = String(source || '').slice(0, MAX_MARKDOWN);
  if (!raw.trim()) return '';
  const html = marked.parse(raw);
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }),
      img: (tagName, attribs) => ({
        tagName: 'img',
        attribs: { ...attribs, loading: 'lazy' },
      }),
    },
  });
}

module.exports = {
  MAX_MARKDOWN,
  DEFAULT_KEY_HELP_MD,
  DEFAULT_TOKEN_HELP_MD,
  renderMarkdown,
};
